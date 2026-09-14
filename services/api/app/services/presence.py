"""Presence: who is in, when, and who is allowed to know (FR-5.1–5.6, TDD §11, PRD Q6).

Two rules shape every query in this module.

**Visibility is enforced in the query, not the serializer.** A user with
`presence_visibility = 'nobody'` is absent from the result set entirely — not returned
with a `hidden` flag for a well-behaved client to respect. A privacy control that
depends on client cooperation is not a control, and the client here is a binary we do
not run.

**Nothing returns a count of people it is not also willing to name.** "14 in the office"
beside a list of 12 identifies the two who opted out, on a small team exactly. So the
endpoints return people, and the caller counts them. Occupancy — how full a floor is —
is a capacity fact and already comes from the availability query, which names nobody.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.errors import NotFound, PolicyViolation, Violation
from app.core.ids import uuid7
from app.models import Absence, Booking, Floor, Group, GroupMember, Organization, Resource, User
from app.models.booking import ACTIVE_STATUSES
from app.policy import codes

ABSENCE_KINDS: frozenset[str] = frozenset({"remote", "leave", "travel"})
VISIBILITY_CHOICES: frozenset[str] = frozenset({"everyone", "team_only", "nobody"})


async def presence_enabled(session: AsyncSession, organization_id: uuid.UUID) -> bool:
    """The org-level kill switch (PRD Q6).

    Some works councils reject colleague visibility outright, and for those tenants the
    feature has to be gone rather than merely hidden. Defaults to on: a tenant that has
    never set it gets the feature.
    """
    settings = await session.scalar(
        select(Organization.settings).where(Organization.id == organization_id)
    )
    return bool((settings or {}).get("presence_enabled", True))


async def require_presence(session: AsyncSession, organization_id: uuid.UUID) -> None:
    if not await presence_enabled(session, organization_id):
        raise NotFound("Presence is not enabled for this organization")


def visible_to(viewer: User) -> ColumnElement[bool]:
    """The condition every presence query must carry.

    Returned as an expression rather than applied by a helper that wraps `select`,
    because the joins differ per query and a wrapper that could be forgotten is the
    same hazard as filtering client-side.
    """
    # Aliased, not reused: two unaliased references to `group_members` let SQLAlchemy
    # auto-correlate the inner subquery to the outer one and drop its FROM clause, which
    # would silently compare the candidate's memberships against themselves — a
    # visibility check that returns true for everyone.
    theirs = aliased(GroupMember)
    mine = aliased(GroupMember)
    shares_a_group = exists(
        select(1)
        .select_from(theirs)
        .where(
            theirs.user_id == User.id,
            theirs.group_id.in_(select(mine.group_id).where(mine.user_id == viewer.id)),
        )
    )
    return and_(
        User.status == "active",
        User.deactivated_at.is_(None),
        or_(
            # You can always see yourself, whatever you have set.
            User.id == viewer.id,
            User.presence_visibility == "everyone",
            and_(User.presence_visibility == "team_only", shares_a_group),
        ),
    )


@dataclass(frozen=True)
class Seat:
    floor_id: uuid.UUID
    floor_name: str
    resource_id: uuid.UUID
    resource_code: str
    #: Normalized plan coordinates (TDD §14.2), so the client can sort by proximity
    #: without a second call — this is what makes "sit near Marcus" (FR-5.3) cheap.
    position: dict


@dataclass(frozen=True)
class Person:
    user_id: uuid.UUID
    display_name: str
    avatar_url: str | None
    #: "in" | "remote" | "leave" | "travel"
    status: str
    seat: Seat | None
    is_me: bool


async def who_is_in(
    session: AsyncSession,
    *,
    viewer: User,
    site_id: uuid.UUID,
    local_date: date,
) -> list[Person]:
    """Colleagues with a desk at this site on this day (FR-5.1).

    Only people actually in the office. Declared absences belong to the team grid, where
    "working from home" is information; here it would be noise.
    """
    rows = await session.execute(
        select(User, Resource, Floor)
        .select_from(Booking)
        .join(User, User.id == Booking.user_id)
        .join(Resource, Resource.id == Booking.resource_id)
        .join(Floor, Floor.id == Resource.floor_id)
        .where(
            Booking.local_date == local_date,
            Booking.status.in_(ACTIVE_STATUSES),
            Resource.site_id == site_id,
            visible_to(viewer),
        )
        .order_by(User.display_name)
    )
    return [
        Person(
            user_id=user.id,
            display_name=user.display_name,
            avatar_url=user.avatar_url,
            status="in",
            seat=Seat(
                floor_id=floor.id,
                floor_name=floor.name,
                resource_id=resource.id,
                resource_code=resource.code,
                position=resource.position or {},
            ),
            is_me=user.id == viewer.id,
        )
        for user, resource, floor in rows
    ]


@dataclass(frozen=True)
class DayPresence:
    local_date: date
    #: "in" | "remote" | "leave" | "travel" | "unknown"
    status: str
    seat: Seat | None


async def _days_for(
    session: AsyncSession,
    *,
    user_ids: list[uuid.UUID],
    dates: list[date],
) -> dict[tuple[uuid.UUID, date], DayPresence]:
    """Bookings and absences for several people over several days, in two queries.

    **Applies no visibility filter of its own.** Callers pass a set of users they have
    already established the viewer may see; this function must never be reachable with
    an unfiltered id list.

    A booking wins over an absence for the same day. The two should not coexist —
    `declare_absence` refuses it — but a desk that exists is the stronger fact, and a
    grid that silently showed "on leave" for someone holding a desk would be worse than
    either.
    """
    if not user_ids or not dates:
        return {}
    out: dict[tuple[uuid.UUID, date], DayPresence] = {}

    absences = await session.execute(
        select(Absence).where(
            Absence.user_id.in_(user_ids),
            Absence.local_date.in_(dates),
        )
    )
    for absence in absences.scalars():
        out[(absence.user_id, absence.local_date)] = DayPresence(
            local_date=absence.local_date, status=absence.kind, seat=None
        )

    bookings = await session.execute(
        select(Booking, Resource, Floor)
        .join(Resource, Resource.id == Booking.resource_id)
        .join(Floor, Floor.id == Resource.floor_id)
        .where(
            Booking.user_id.in_(user_ids),
            Booking.local_date.in_(dates),
            Booking.status.in_(ACTIVE_STATUSES),
        )
    )
    for booking, resource, floor in bookings:
        out[(booking.user_id, booking.local_date)] = DayPresence(
            local_date=booking.local_date,
            status="in",
            seat=Seat(
                floor_id=floor.id,
                floor_name=floor.name,
                resource_id=resource.id,
                resource_code=resource.code,
                position=resource.position or {},
            ),
        )
    return out


async def user_presence(
    session: AsyncSession,
    *,
    viewer: User,
    user_id: uuid.UUID,
    dates: list[date],
) -> tuple[User, list[DayPresence]]:
    """One colleague's upcoming office days (FR-5.2), subject to their setting (FR-5.6).

    A hidden colleague raises NotFound rather than Forbidden. "You may not see this
    person's days" still confirms the person exists and has chosen to hide — which is
    itself the thing they hid.
    """
    subject = await session.scalar(select(User).where(User.id == user_id, visible_to(viewer)))
    if subject is None:
        raise NotFound("User not found")

    days = await _days_for(session, user_ids=[subject.id], dates=dates)
    return subject, [
        days.get((subject.id, day), DayPresence(local_date=day, status="unknown", seat=None))
        for day in dates
    ]


async def search_colleagues(
    session: AsyncSession,
    *,
    viewer: User,
    query: str,
    limit: int = 20,
) -> list[User]:
    """Name search for FR-5.2 and FR-5.3.

    Matches on display name only. Email would turn this into a directory scrape of
    everyone who left presence on, which is not what "find a colleague" asks for.
    """
    term = query.strip()
    if len(term) < 2:
        return []
    rows = await session.scalars(
        select(User)
        .where(
            func.lower(User.display_name).like(f"%{term.lower()}%"),
            visible_to(viewer),
        )
        .order_by(User.display_name)
        .limit(limit)
    )
    return list(rows)


@dataclass(frozen=True)
class TeamMember:
    user_id: uuid.UUID
    display_name: str
    avatar_url: str | None
    is_me: bool
    days: list[DayPresence]


async def team_grid(
    session: AsyncSession,
    *,
    viewer: User,
    group_id: uuid.UUID | None,
    dates: list[date],
) -> tuple[Group | None, list[TeamMember]]:
    """A week of the team's planned presence (FR-5.4).

    Defaults to the viewer's own group. Members who have hidden themselves are simply
    not rows — the grid is smaller, rather than showing blanks that would identify them.
    """
    if group_id is None:
        group_id = await session.scalar(
            select(GroupMember.group_id).where(GroupMember.user_id == viewer.id).limit(1)
        )
    if group_id is None:
        return None, []

    # Membership of a group you are not in is not public. Asking for someone else's
    # team reads as an empty team rather than an error, for the same reason as above.
    is_member = await session.scalar(
        select(1).where(
            GroupMember.group_id == group_id,
            GroupMember.user_id == viewer.id,
        )
    )
    if not is_member:
        return None, []

    group = await session.scalar(select(Group).where(Group.id == group_id))
    members = list(
        await session.scalars(
            select(User)
            .join(GroupMember, GroupMember.user_id == User.id)
            .where(GroupMember.group_id == group_id, visible_to(viewer))
            .order_by(User.display_name)
        )
    )
    days = await _days_for(session, user_ids=[m.id for m in members], dates=dates)
    return group, [
        TeamMember(
            user_id=m.id,
            display_name=m.display_name,
            avatar_url=m.avatar_url,
            is_me=m.id == viewer.id,
            days=[
                days.get((m.id, day), DayPresence(local_date=day, status="unknown", seat=None))
                for day in dates
            ],
        )
        for m in members
    ]


async def declare_absence(
    session: AsyncSession,
    *,
    user: User,
    local_date: date,
    kind: str,
) -> Absence:
    """Declare remote / leave / travel for a day (FR-5.5).

    Refused while the user still holds a desk that day, rather than silently cancelling
    it. Cancelling a booking is a side effect nobody asked for, and holding a desk you
    have just said you will not use is exactly the waste this product exists to remove —
    so the refusal names the booking and the client offers to cancel it (TDD §11).
    """
    if kind not in ABSENCE_KINDS:
        raise PolicyViolation(
            f"unknown absence kind {kind!r}",
            violations=[
                Violation(
                    code=codes.ABSENCE_KIND_UNKNOWN,
                    params={"kind": kind, "allowed": sorted(ABSENCE_KINDS)},
                )
            ],
        )

    booking = await session.execute(
        select(Booking, Resource.code)
        .join(Resource, Resource.id == Booking.resource_id)
        .where(
            Booking.user_id == user.id,
            Booking.local_date == local_date,
            Booking.status.in_(ACTIVE_STATUSES),
        )
        .limit(1)
    )
    held = booking.first()
    if held is not None:
        existing, code = held
        raise PolicyViolation(
            "user holds a booking on that date",
            violations=[
                Violation(
                    code=codes.ABSENCE_CONFLICTS_WITH_BOOKING,
                    params={
                        "date": local_date.isoformat(),
                        "booking_id": str(existing.id),
                        "resource_code": code,
                    },
                )
            ],
        )

    absence = await session.scalar(
        select(Absence).where(Absence.user_id == user.id, Absence.local_date == local_date)
    )
    if absence is None:
        absence = Absence(
            id=uuid7(),
            organization_id=user.organization_id,
            user_id=user.id,
            local_date=local_date,
            kind=kind,
        )
        session.add(absence)
    else:
        absence.kind = kind
    await session.flush()
    return absence


async def clear_absence(session: AsyncSession, *, user: User, local_date: date) -> bool:
    absence = await session.scalar(
        select(Absence).where(Absence.user_id == user.id, Absence.local_date == local_date)
    )
    if absence is None:
        return False
    await session.delete(absence)
    await session.flush()
    return True


async def absences_between(
    session: AsyncSession, *, user: User, start: date, end: date
) -> list[Absence]:
    rows = await session.scalars(
        select(Absence)
        .where(
            Absence.user_id == user.id,
            Absence.local_date >= start,
            Absence.local_date <= end,
        )
        .order_by(Absence.local_date)
    )
    return list(rows)


async def set_visibility(session: AsyncSession, *, user: User, visibility: str) -> User:
    if visibility not in VISIBILITY_CHOICES:
        raise PolicyViolation(
            f"unknown visibility {visibility!r}",
            violations=[
                Violation(
                    code=codes.VISIBILITY_UNKNOWN,
                    params={"visibility": visibility, "allowed": sorted(VISIBILITY_CHOICES)},
                )
            ],
        )
    user.presence_visibility = visibility
    await session.flush()
    return user


def initials_of(display_name: str) -> str:
    """Tinted initials rather than photographs: nothing to upload, nothing to moderate,
    and it degrades honestly when a directory has no avatar."""
    parts = [p for p in display_name.split() if p]
    return "".join(p[0].upper() for p in parts[:2]) or "?"
