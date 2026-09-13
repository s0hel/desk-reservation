"""Floor layout documents: draft, diff, publish (TDD §14.3).

A floor's editable layout is one JSON document (see migration 0003 for why it is a
document and not a status column). This module owns three things:

1. **Reading** — the current layout, which is the draft if one exists and otherwise a
   projection of the live rows. The editor never needs to know which it got.
2. **Diffing** — what publishing this draft would do to the live rows, including the
   bookings it would strand. Computed separately from applying it so the console can
   show the admin the consequences before anything happens (TDD §14.3: "publishing a
   floor that would orphan existing bookings warns with the affected count").
3. **Publishing** — applying that diff in one transaction.

Identity across the boundary: every item carries a client-stable `key` and an `id` that
is null until the item has been published once. The editor works in `key` space, so
undo/redo and re-ordering never depend on server round-trips; publish is what mints ids,
after which the draft is regenerated from live rows so the two agree.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ProblemError, Violation
from app.core.ids import uuid7
from app.core.time import now_utc
from app.models import (
    ACTIVE_STATUSES,
    Booking,
    Floor,
    FloorDraft,
    FloorPlanAsset,
    Resource,
    User,
    Zone,
    ZonePermission,
)
from app.services import attributes as attribute_schemas
from app.services.booking import cancel_booking

LAYOUT_VERSION = 1

Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
Key = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class InvalidLayout(ProblemError):
    status, type_slug, title = 422, "invalid-layout", "Invalid layout"


class PublishBlocked(ProblemError):
    """Publishing would strand bookings and the admin has not accepted that."""

    status, type_slug, title = 409, "publish-blocked", "Publishing would affect bookings"


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Normalized to the plan image, never pixels (TDD §14.2).
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    rotation: float = Field(default=0.0, ge=-360.0, le=360.0)


class LayoutZonePermission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    group_id: uuid.UUID
    mode: Literal["exclusive", "preferred", "open_after"] = "exclusive"
    opens_at_local: str | None = None


class LayoutZone(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: Key
    id: uuid.UUID | None = None
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    kind: str = "neighborhood"
    polygon: list[tuple[float, float]] = Field(default_factory=list)
    color: str | None = None
    permissions: list[LayoutZonePermission] = Field(default_factory=list)

    @field_validator("polygon")
    @classmethod
    def _closed_and_in_range(cls, value: list[tuple[float, float]]):
        if len(value) < 3:
            raise ValueError("a zone needs at least three points")
        for x, y in value:
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                raise ValueError("zone points are normalized to 0..1")
        return value


class LayoutResource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: Key
    id: uuid.UUID | None = None
    kind: Literal["desk", "room"] = "desk"
    code: Code
    name: str | None = None
    position: Position
    capacity: int = Field(default=1, ge=1, le=500)
    attributes: dict = Field(default_factory=dict)
    zone_key: str | None = None
    bookable: bool = True
    out_of_service_reason: str | None = None


class FloorLayout(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = LAYOUT_VERSION
    plan_asset_id: uuid.UUID | None = None
    resources: list[LayoutResource] = Field(default_factory=list)
    zones: list[LayoutZone] = Field(default_factory=list)


# --------------------------------------------------------------------------- reading


async def layout_from_live(session: AsyncSession, floor: Floor) -> FloorLayout:
    """Project the published rows back into a layout document."""
    zones = list(await session.scalars(select(Zone).where(Zone.floor_id == floor.id)))
    zone_ids = [z.id for z in zones]
    permissions: dict[uuid.UUID, list[ZonePermission]] = {z.id: [] for z in zones}
    if zone_ids:
        for permission in await session.scalars(
            select(ZonePermission).where(ZonePermission.zone_id.in_(zone_ids))
        ):
            permissions[permission.zone_id].append(permission)

    resources = list(
        await session.scalars(
            select(Resource)
            .where(Resource.floor_id == floor.id)
            # Retired resources are history, not layout: a desk that was removed but
            # still carries bookings keeps its row (see `publish`) and must not
            # reappear in the editor as something to place.
            .where(Resource.status == "active")
            .order_by(Resource.code)
        )
    )
    # Live rows use their own id as the key, so a document round-tripped through publish
    # is stable and a diff of an unedited layout is empty.
    return FloorLayout(
        version=LAYOUT_VERSION,
        plan_asset_id=floor.plan_asset_id,
        zones=[
            LayoutZone(
                key=str(z.id),
                id=z.id,
                name=z.name,
                kind=z.kind,
                polygon=[(p[0], p[1]) for p in (z.polygon or [])],
                color=z.color,
                permissions=[
                    LayoutZonePermission(
                        group_id=p.group_id,
                        mode=p.mode,
                        opens_at_local=p.opens_at_local.isoformat() if p.opens_at_local else None,
                    )
                    for p in permissions.get(z.id, [])
                ],
            )
            for z in zones
            # A zone with fewer than three points cannot have been drawn by the editor;
            # skip rather than fail the whole read on legacy or seeded data.
            if len(z.polygon or []) >= 3
        ],
        resources=[
            LayoutResource(
                key=str(r.id),
                id=r.id,
                kind=r.kind,
                code=r.code,
                name=r.name,
                position=Position(
                    x=float((r.position or {}).get("x") or 0.0),
                    y=float((r.position or {}).get("y") or 0.0),
                    rotation=float((r.position or {}).get("rotation") or 0.0),
                ),
                capacity=r.capacity,
                attributes=r.attributes or {},
                zone_key=str(r.zone_id) if r.zone_id else None,
                bookable=r.bookable,
                out_of_service_reason=r.out_of_service_reason,
            )
            for r in resources
        ],
    )


async def get_draft(session: AsyncSession, floor: Floor) -> FloorDraft | None:
    return await session.scalar(select(FloorDraft).where(FloorDraft.floor_id == floor.id))


async def current_layout(session: AsyncSession, floor: Floor) -> tuple[FloorLayout, bool]:
    """(layout, is_draft). The editor opens whatever is in progress, not what is live."""
    draft = await get_draft(session, floor)
    if draft is not None:
        return FloorLayout.model_validate(draft.layout), True
    return await layout_from_live(session, floor), False


# ------------------------------------------------------------------------ validation


def _validate(layout: FloorLayout) -> FloorLayout:
    """Cross-item rules Pydantic cannot express field by field."""
    violations: list[Violation] = []

    zone_keys = {z.key for z in layout.zones}
    if len(zone_keys) != len(layout.zones):
        violations.append(Violation(code="layout.duplicate_zone_key"))

    resource_keys = [r.key for r in layout.resources]
    if len(set(resource_keys)) != len(resource_keys):
        violations.append(Violation(code="layout.duplicate_resource_key"))

    seen: dict[str, str] = {}
    for resource in layout.resources:
        folded = resource.code.casefold()
        if folded in seen:
            violations.append(
                Violation(code="layout.duplicate_code", params={"code": resource.code})
            )
        seen[folded] = resource.key
        if resource.zone_key is not None and resource.zone_key not in zone_keys:
            violations.append(
                Violation(
                    code="layout.unknown_zone",
                    params={"code": resource.code, "zone_key": resource.zone_key},
                )
            )

    # Attribute validation fills defaults, so this both checks and normalizes. Every
    # resource is checked before anything is raised: an admin fixing a 300-desk import
    # one error per round trip abandons the import (PRD risk R5).
    for resource in layout.resources:
        normalized, problems = attribute_schemas.validate(
            resource.kind, resource.attributes, where=resource.code
        )
        if problems:
            violations.extend(problems)
        else:
            resource.attributes = normalized

    if violations:
        raise InvalidLayout("Layout failed validation", violations=violations[:20])
    return layout


async def _assert_codes_free_on_other_floors(
    session: AsyncSession, floor: Floor, layout: FloorLayout
) -> None:
    """`UNIQUE (site_id, code)` spans the whole site, not one floor.

    Catching this here turns an opaque IntegrityError on publish into a named list of
    the codes that clash, which is the difference between "publish failed" and "4F-A-03
    already exists on Floor 5".
    """
    codes = [r.code for r in layout.resources]
    if not codes:
        return
    clashes = list(
        await session.scalars(
            select(Resource.code)
            .where(Resource.site_id == floor.site_id)
            .where(Resource.floor_id != floor.id)
            .where(Resource.code.in_(codes))
        )
    )
    if clashes:
        raise InvalidLayout(
            "Codes are already used elsewhere on this site",
            violations=[
                Violation(code="layout.code_taken_on_site", params={"code": c})
                for c in sorted(set(clashes))[:20]
            ],
        )


async def save_draft(
    session: AsyncSession, floor: Floor, layout: FloorLayout, actor: User
) -> FloorDraft:
    layout = _validate(layout)
    await _assert_codes_free_on_other_floors(session, floor, layout)

    draft = await get_draft(session, floor)
    payload = layout.model_dump(mode="json")
    if draft is None:
        draft = FloorDraft(
            id=uuid7(),
            organization_id=floor.organization_id,
            floor_id=floor.id,
            layout=payload,
            base_version=0,
            updated_by_user_id=actor.id,
        )
        session.add(draft)
    else:
        draft.layout = payload
        draft.base_version += 1
        draft.updated_by_user_id = actor.id
    await session.flush()
    return draft


# ----------------------------------------------------------------------- diff/publish


@dataclass
class OrphanedResource:
    resource_id: uuid.UUID
    code: str
    bookings: int
    reason: Literal["deleted", "unbookable"]


@dataclass
class PublishPlan:
    creates: list[LayoutResource] = field(default_factory=list)
    updates: list[tuple[Resource, LayoutResource]] = field(default_factory=list)
    deletes: list[Resource] = field(default_factory=list)
    zone_creates: list[LayoutZone] = field(default_factory=list)
    zone_updates: list[tuple[Zone, LayoutZone]] = field(default_factory=list)
    zone_deletes: list[Zone] = field(default_factory=list)
    orphans: list[OrphanedResource] = field(default_factory=list)
    aspect_ratio_change: tuple[float, float] | None = None

    @property
    def affected_bookings(self) -> int:
        return sum(o.bookings for o in self.orphans)

    @property
    def is_empty(self) -> bool:
        return not (
            self.creates
            or self.updates
            or self.deletes
            or self.zone_creates
            or self.zone_updates
            or self.zone_deletes
            or self.aspect_ratio_change
        )


def _changed(live: Resource, draft: LayoutResource) -> bool:
    """Whether publishing this item would actually write anything.

    Without this every existing desk lands in the update list, and the preflight an
    admin is asked to read says "312 updates" on a floor nobody touched — which trains
    them to click through the one screen that exists to make them look.
    """
    position = live.position or {}
    moved = (
        abs(float(position.get("x") or 0.0) - draft.position.x) > 1e-9
        or abs(float(position.get("y") or 0.0) - draft.position.y) > 1e-9
        or abs(float(position.get("rotation") or 0.0) - draft.position.rotation) > 1e-9
    )
    live_zone_key = str(live.zone_id) if live.zone_id else None
    return (
        moved
        or live.code != draft.code
        or (live.name or None) != (draft.name or None)
        or live.kind != draft.kind
        or live.capacity != draft.capacity
        or (live.attributes or {}) != draft.attributes
        or live_zone_key != draft.zone_key
        or live.bookable != draft.bookable
        or (live.out_of_service_reason or None) != (draft.out_of_service_reason or None)
    )


def _zone_changed(live: Zone, draft: LayoutZone) -> bool:
    return (
        live.name != draft.name
        or live.kind != draft.kind
        or [list(p) for p in (live.polygon or [])] != [list(p) for p in draft.polygon]
        or (live.color or None) != (draft.color or None)
    )


async def _future_booking_counts(
    session: AsyncSession, resource_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Bookings from today onward. Past bookings are history and must not block an edit
    — a desk that was removed last month still happened."""
    if not resource_ids:
        return {}
    today = now_utc().date()
    rows = await session.execute(
        select(Booking.resource_id, Booking.id)
        .where(Booking.resource_id.in_(resource_ids))
        .where(Booking.local_date >= today)
        .where(Booking.status.in_([s.value for s in ACTIVE_STATUSES]))
    )
    counts: dict[uuid.UUID, int] = {}
    for resource_id, _ in rows.all():
        counts[resource_id] = counts.get(resource_id, 0) + 1
    return counts


async def build_plan(session: AsyncSession, floor: Floor, layout: FloorLayout) -> PublishPlan:
    """What publishing this layout would do. Pure computation — nothing is written."""
    plan = PublishPlan()

    live_resources = {
        r.id: r
        for r in await session.scalars(
            select(Resource).where(Resource.floor_id == floor.id).where(Resource.status == "active")
        )
    }
    live_zones = {
        z.id: z for z in await session.scalars(select(Zone).where(Zone.floor_id == floor.id))
    }

    for zone in layout.zones:
        existing = live_zones.get(zone.id) if zone.id else None
        if existing is None:
            plan.zone_creates.append(zone)
        elif _zone_changed(existing, zone) or zone.permissions:
            # Permissions are replaced wholesale on publish, so a zone that carries any
            # is always "an update" — there is no cheap way to know they match.
            plan.zone_updates.append((existing, zone))
    kept_zone_ids = {z.id for z in layout.zones if z.id}
    plan.zone_deletes = [z for zid, z in live_zones.items() if zid not in kept_zone_ids]

    for resource in layout.resources:
        existing = live_resources.get(resource.id) if resource.id else None
        if existing is None:
            plan.creates.append(resource)
        elif _changed(existing, resource):
            plan.updates.append((existing, resource))
    kept_ids = {r.id for r in layout.resources if r.id}
    plan.deletes = [r for rid, r in live_resources.items() if rid not in kept_ids]

    # Anything a booking could be attached to that will stop being bookable.
    at_risk = [r.id for r in plan.deletes]
    newly_unbookable = [
        live.id for live, draft in plan.updates if live.bookable and not draft.bookable
    ]
    at_risk += newly_unbookable
    counts = await _future_booking_counts(session, at_risk)
    for resource in plan.deletes:
        if counts.get(resource.id):
            plan.orphans.append(
                OrphanedResource(resource.id, resource.code, counts[resource.id], "deleted")
            )
    for live, _ in plan.updates:
        if live.id in newly_unbookable and counts.get(live.id):
            plan.orphans.append(OrphanedResource(live.id, live.code, counts[live.id], "unbookable"))

    # A desk that only moves keeps its bookings — its identity is its row, not its
    # coordinates — so movement is deliberately not an orphan case.
    if layout.plan_asset_id != floor.plan_asset_id and floor.plan_width_px and floor.plan_height_px:
        incoming = (
            await session.scalar(
                select(FloorPlanAsset).where(FloorPlanAsset.id == layout.plan_asset_id)
            )
            if layout.plan_asset_id
            else None
        )
        if incoming and incoming.height_px:
            was = floor.plan_width_px / floor.plan_height_px
            now = incoming.width_px / incoming.height_px
            # 1% tolerance: a rescan is never pixel-identical, and warning about a
            # ratio change of 0.3% would train admins to click through the warning.
            if abs(was - now) / was > 0.01:
                plan.aspect_ratio_change = (round(was, 4), round(now, 4))

    return plan


async def publish(
    session: AsyncSession,
    floor: Floor,
    layout: FloorLayout,
    actor: User,
    *,
    accept_orphans: bool = False,
) -> PublishPlan:
    layout = _validate(layout)
    await _assert_codes_free_on_other_floors(session, floor, layout)
    plan = await build_plan(session, floor, layout)
    live_zone_by_id = {
        z.id: z for z in await session.scalars(select(Zone).where(Zone.floor_id == floor.id))
    }

    if plan.orphans and not accept_orphans:
        raise PublishBlocked(
            "Publishing would strand existing bookings",
            violations=[
                Violation(
                    code="publish.orphaned_bookings",
                    params={
                        "bookings": plan.affected_bookings,
                        "resources": [o.code for o in plan.orphans[:20]],
                    },
                    severity="block",
                )
            ],
        )

    # Zones first: a resource can point at one, and a zone created in this same publish
    # has no id until it is flushed.
    #
    # The map is built from EVERY zone in the layout, not only the ones the plan says
    # changed. Resources are re-attached by key below, so a zone left out of the map
    # reads as "no zone" and would quietly orphan every desk inside an unedited
    # neighbourhood.
    key_to_zone_id: dict[str, uuid.UUID] = {}
    changed_zone_keys = {zone.key for _, zone in plan.zone_updates}
    for zone in layout.zones:
        existing = live_zone_by_id.get(zone.id) if zone.id else None
        if existing is None:
            row = Zone(
                id=uuid7(),
                organization_id=floor.organization_id,
                floor_id=floor.id,
                name=zone.name,
                kind=zone.kind,
                polygon=[list(p) for p in zone.polygon],
                color=zone.color,
            )
            session.add(row)
            key_to_zone_id[zone.key] = row.id
            continue
        if zone.key in changed_zone_keys:
            existing.name = zone.name
            existing.kind = zone.kind
            existing.polygon = [list(p) for p in zone.polygon]
            existing.color = zone.color
        key_to_zone_id[zone.key] = existing.id
    await session.flush()

    # Zone permissions are replaced wholesale rather than diffed: the set is small, the
    # editor sends the complete intended state, and a partial update is how a revoked
    # permission survives a save.
    surviving_zone_ids = list(key_to_zone_id.values())
    if surviving_zone_ids:
        await session.execute(
            delete(ZonePermission).where(ZonePermission.zone_id.in_(surviving_zone_ids))
        )
    for zone in layout.zones:
        zone_id = key_to_zone_id.get(zone.key)
        if zone_id is None:
            continue
        for permission in zone.permissions:
            session.add(
                ZonePermission(
                    id=uuid7(),
                    organization_id=floor.organization_id,
                    zone_id=zone_id,
                    group_id=permission.group_id,
                    mode=permission.mode,
                )
            )

    for resource in plan.creates:
        session.add(
            Resource(
                id=uuid7(),
                organization_id=floor.organization_id,
                site_id=floor.site_id,
                floor_id=floor.id,
                zone_id=key_to_zone_id.get(resource.zone_key) if resource.zone_key else None,
                kind=resource.kind,
                code=resource.code,
                name=resource.name,
                position=resource.position.model_dump(),
                capacity=resource.capacity,
                attributes=resource.attributes,
                bookable=resource.bookable,
                out_of_service_reason=resource.out_of_service_reason,
            )
        )
    live_by_id = {
        r.id: r
        for r in await session.scalars(
            select(Resource).where(Resource.floor_id == floor.id).where(Resource.status == "active")
        )
    }
    changed_resource_keys = {resource.key for _, resource in plan.updates}
    for resource in layout.resources:
        existing = live_by_id.get(resource.id) if resource.id else None
        if existing is None or resource.key not in changed_resource_keys:
            # Unchanged, but its zone may have been created in this publish and the key
            # map is the only place the new id exists.
            if existing is not None:
                existing.zone_id = (
                    key_to_zone_id.get(resource.zone_key) if resource.zone_key else None
                )
            continue
        if existing.bookable and not resource.bookable:
            # Out of service is the other way a booking gets stranded (FR-8.6). It is
            # the same obligation as removal: tell the people who lose the desk.
            for booking_id in await session.scalars(
                select(Booking.id)
                .where(Booking.resource_id == existing.id)
                .where(Booking.local_date >= now_utc().date())
                .where(Booking.status.in_([s.value for s in ACTIVE_STATUSES]))
            ):
                await cancel_booking(
                    session,
                    actor=actor,
                    booking_id=booking_id,
                    reason=resource.out_of_service_reason
                    or f"{resource.code} was taken out of service",
                )
        existing.zone_id = key_to_zone_id.get(resource.zone_key) if resource.zone_key else None
        existing.kind = resource.kind
        existing.code = resource.code
        existing.name = resource.name
        existing.position = resource.position.model_dump()
        existing.capacity = resource.capacity
        existing.attributes = resource.attributes
        existing.bookable = resource.bookable
        existing.out_of_service_reason = resource.out_of_service_reason

    for resource in plan.deletes:
        # A removed desk is not always a deletable row. `bookings.resource_id` cascades,
        # so dropping a desk that has ever been booked would erase that history — and
        # utilization reporting is one of the two things the buyer is paying for.
        #
        # So: delete only what nobody has ever booked, and retire the rest. Retired rows
        # are excluded from availability (`status = 'active'` in the availability query)
        # and from the editor, so the desk is gone everywhere a user can see it while
        # its bookings survive.
        ever_booked = await session.scalar(
            select(Booking.id).where(Booking.resource_id == resource.id).limit(1)
        )
        if ever_booked is None:
            await session.delete(resource)
            continue

        # Cancel through the booking service rather than by hand: cancellation is what
        # writes the outbox event that tells the person they lost their desk.
        for booking_id in await session.scalars(
            select(Booking.id)
            .where(Booking.resource_id == resource.id)
            .where(Booking.local_date >= now_utc().date())
            .where(Booking.status.in_([s.value for s in ACTIVE_STATUSES]))
        ):
            await cancel_booking(
                session,
                actor=actor,
                booking_id=booking_id,
                reason=f"{resource.code} was removed from {floor.name}",
            )
        resource.status = "retired"
        resource.bookable = False

    for zone in plan.zone_deletes:
        await session.delete(zone)

    if layout.plan_asset_id != floor.plan_asset_id:
        asset = (
            await session.scalar(
                select(FloorPlanAsset).where(FloorPlanAsset.id == layout.plan_asset_id)
            )
            if layout.plan_asset_id
            else None
        )
        floor.plan_asset_id = asset.id if asset else None
        floor.plan_width_px = asset.width_px if asset else None
        floor.plan_height_px = asset.height_px if asset else None

    floor.published_at = now_utc()
    await session.flush()

    # The draft is now stale in exactly one way that matters: new items have real ids.
    # Regenerating it from live rows is simpler than patching keys, and it means a
    # reopened editor and a fresh one show the same thing.
    draft = await get_draft(session, floor)
    if draft is not None:
        draft.layout = (await layout_from_live(session, floor)).model_dump(mode="json")
        draft.base_version += 1
        draft.updated_by_user_id = actor.id
    await session.flush()
    return plan


async def discard_draft(session: AsyncSession, floor: Floor) -> bool:
    draft = await get_draft(session, floor)
    if draft is None:
        return False
    await session.delete(draft)
    await session.flush()
    return True


def plan_summary(plan: PublishPlan, published_at: datetime | None = None) -> dict:
    return {
        "creates": len(plan.creates),
        "updates": len(plan.updates),
        "deletes": len(plan.deletes),
        "zone_creates": len(plan.zone_creates),
        "zone_updates": len(plan.zone_updates),
        "zone_deletes": len(plan.zone_deletes),
        "affected_bookings": plan.affected_bookings,
        "orphans": [
            {
                "resource_id": str(o.resource_id),
                "code": o.code,
                "bookings": o.bookings,
                "reason": o.reason,
            }
            for o in plan.orphans
        ],
        "aspect_ratio_change": (
            {"from": plan.aspect_ratio_change[0], "to": plan.aspect_ratio_change[1]}
            if plan.aspect_ratio_change
            else None
        ),
        "is_empty": plan.is_empty,
        "published_at": published_at,
    }
