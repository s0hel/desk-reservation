"""Zone permissions and blackouts (FR-6.4, FR-6.5).

Both were modelled in Phase 0, both are authored by the admin console, and until now
neither bound anything: the floor plan editor could mark a zone exclusive to one team
and publish it, and every employee could still book those desks. A control that is
written and never read is worse than no control, because it is believed.

The decision shapes here are **pure functions**, and the two callers that matter — the
policy rule at booking time and the availability query that colours the plan — both go
through them. That is the point of the module: if availability computed "can this
person book this desk" separately from the rule that refuses the booking, the two would
drift, and the failure mode is a desk that renders green and then refuses. Which is the
exact bug this work exists to remove.
"""

import uuid
from collections.abc import Iterable, Sequence
from datetime import date, datetime, time

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Violation
from app.core.time import local_time_to_utc
from app.models import Blackout, GroupMember, ZonePermission
from app.policy import codes

#: Modes that gate access. `preferred` is a ranking hint for auto-assign (FR-2.9) and is
#: deliberately not an access rule — treating it as one would let a "preferred" row on a
#: zone silently widen an `exclusive` row on the same zone.
GATING_MODES: frozenset[str] = frozenset({"exclusive", "open_after"})


async def group_ids_for(session: AsyncSession, user_id: uuid.UUID) -> frozenset[uuid.UUID]:
    rows = await session.scalars(select(GroupMember.group_id).where(GroupMember.user_id == user_id))
    return frozenset(rows)


async def zone_permissions_for(
    session: AsyncSession, zone_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, list[ZonePermission]]:
    ids = [z for z in zone_ids if z is not None]
    if not ids:
        return {}
    rows = await session.scalars(select(ZonePermission).where(ZonePermission.zone_id.in_(ids)))
    out: dict[uuid.UUID, list[ZonePermission]] = {}
    for permission in rows:
        out.setdefault(permission.zone_id, []).append(permission)
    return out


async def blackouts_for(
    session: AsyncSession,
    *,
    site_id: uuid.UUID,
    start: date,
    end: date,
) -> list[Blackout]:
    """Every blackout overlapping the range for this site, its floors, or the whole org.

    A row with both `site_id` and `floor_id` null is org-wide — a company holiday — and
    must reach every site, which is why this filters on "mine or global" rather than
    equality.
    """
    rows = await session.scalars(
        select(Blackout).where(
            Blackout.starts_on <= end,
            Blackout.ends_on >= start,
            or_(Blackout.site_id.is_(None), Blackout.site_id == site_id),
        )
    )
    return list(rows)


def blackout_hit(
    blackouts: Sequence[Blackout],
    *,
    local_date: date,
    floor_id: uuid.UUID | None,
) -> Blackout | None:
    """The first blackout covering this date and this floor, if any.

    `floor_id=None` asks "is anything blacked out anywhere at this site that day", which
    is what the week strip needs; a floor-specific blackout does not close the site.
    """
    for b in blackouts:
        if not (b.starts_on <= local_date <= b.ends_on):
            continue
        if b.floor_id is not None and b.floor_id != floor_id:
            continue
        return b
    return None


def blackout_violation(
    blackouts: Sequence[Blackout],
    *,
    local_date: date,
    floor_id: uuid.UUID | None,
) -> Violation | None:
    hit = blackout_hit(blackouts, local_date=local_date, floor_id=floor_id)
    if hit is None:
        return None
    return Violation(
        code=codes.BLACKOUT,
        params={
            "date": local_date.isoformat(),
            # Free text written by an admin, rendered as a quoted aside rather than as
            # the message itself — the client still composes the sentence from the code.
            "reason": hit.reason or "",
        },
        severity="block",
    )


def zone_violation(
    permissions: Sequence[ZonePermission],
    *,
    member_of: frozenset[uuid.UUID],
    site_timezone: str,
    local_date: date,
    now: datetime,
) -> Violation | None:
    """Whether this person may book in this zone, right now (FR-6.4).

    Evaluated per row, because the modes combine. A zone held for Design but opened to
    everyone at 14:00 carries two rows, and reading them independently is what gets both
    "Design always" and "everyone after 14:00" right — collapsing them into a single
    membership test gets one of the two wrong whichever way it is written.

    The `open_after` cut-off is wall-clock on the **booked date**, at the site. So a
    zone with a 14:00 release is exclusive for Monday's desks until 14:00 on Monday, and
    then anyone may take what is left. That is the same-day release a flex office
    actually wants; a cut-off relative to the booking horizon would need a second field
    and nothing in the schema offers one.
    """
    gating = [p for p in permissions if p.mode in GATING_MODES]
    if not gating:
        return None

    opens_at: time | None = None
    for permission in gating:
        if permission.group_id in member_of:
            return None
        if permission.mode == "open_after" and permission.opens_at_local is not None:
            release = local_time_to_utc(site_timezone, local_date, permission.opens_at_local)
            if now >= release:
                return None
            # Report the earliest release, which is the soonest this person gets in.
            if opens_at is None or permission.opens_at_local < opens_at:
                opens_at = permission.opens_at_local

    if opens_at is not None:
        return Violation(
            code=codes.ZONE_NOT_YET_OPEN,
            params={"opens_at": opens_at.isoformat(timespec="minutes"), "timezone": site_timezone},
            severity="block",
        )
    return Violation(code=codes.ZONE_NOT_PERMITTED, params={}, severity="block")
