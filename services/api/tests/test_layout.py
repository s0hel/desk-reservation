"""Floor layout drafts and publishing (TDD §14.3).

The behaviour worth testing here is not "the JSON round-trips" — it is the set of
promises the editor makes to an admin who is about to change a floor that people are
already booking: that nothing is visible until published, that publishing says what it
will break before it breaks it, and that removing a desk never destroys the record of
who sat there.
"""

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import Range

from app.core.ids import uuid7
from app.core.time import now_utc
from app.db.session import SessionFactory, _apply_tenant
from app.models import (
    Booking,
    BookingStatus,
    Floor,
    FloorPlanAsset,
    Group,
    Organization,
    Outbox,
    Resource,
    Site,
    User,
    Zone,
)
from app.services import layout as layout_service
from app.services.booking import BookingRequest, create_booking
from app.services.layout import (
    InvalidLayout,
    LayoutResource,
    LayoutZone,
    Position,
    PublishBlocked,
)

HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}


def next_monday() -> date:
    """Publishing only cares about bookings from today onward, so the fixtures have to
    use a real future date rather than a fixed one that will drift into the past."""
    today = now_utc().date()
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)


class World:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    other_floor: uuid.UUID
    desks: list[uuid.UUID]
    user: uuid.UUID
    group: uuid.UUID


@pytest.fixture
async def world() -> World:
    w = World()
    w.org = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, w.org)
        s.add(Organization(id=w.org, name="t", slug=f"t-{w.org.hex[:8]}"))
        await s.flush()

        site = Site(
            id=uuid7(),
            organization_id=w.org,
            name="HQ",
            timezone="Europe/Berlin",
            opening_hours=HOURS,
        )
        s.add(site)
        await s.flush()
        w.site = site.id

        floor = Floor(id=uuid7(), organization_id=w.org, site_id=site.id, name="F1")
        other = Floor(id=uuid7(), organization_id=w.org, site_id=site.id, name="F2", ordinal=2)
        s.add_all([floor, other])
        await s.flush()
        w.floor, w.other_floor = floor.id, other.id

        w.desks = []
        for i in range(3):
            r = Resource(
                id=uuid7(),
                organization_id=w.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="desk",
                code=f"A-{i:02d}",
                position={"x": 0.1 * (i + 1), "y": 0.2, "rotation": 0},
                capacity=1,
                attributes={},
            )
            s.add(r)
            w.desks.append(r.id)

        user = User(
            id=uuid7(),
            organization_id=w.org,
            email=f"admin-{w.org.hex[:6]}@t.example",
            display_name="Admin",
            home_site_id=site.id,
        )
        s.add(user)
        w.user = user.id

        group = Group(id=uuid7(), organization_id=w.org, name="Engineering")
        s.add(group)
        w.group = group.id
        await s.commit()
    return w


async def _session(org):
    s = SessionFactory()
    await s.begin()
    await _apply_tenant(s, org)
    return s


async def _floor(s, floor_id) -> Floor:
    return await s.scalar(select(Floor).where(Floor.id == floor_id))


async def _user(s, user_id) -> User:
    return await s.scalar(select(User).where(User.id == user_id))


# ------------------------------------------------------------------------- reading


async def test_layout_from_live_round_trips_without_a_diff(world):
    """An untouched floor must produce an empty publish plan. If projecting live rows
    into a document and diffing it back produces spurious changes, every preflight the
    admin sees is noise."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        layout, is_draft = await layout_service.current_layout(s, floor)
        assert is_draft is False
        assert len(layout.resources) == 3

        plan = await layout_service.build_plan(s, floor, layout)
        assert plan.is_empty, (
            f"unedited layout produced changes: "
            f"{len(plan.creates)}c/{len(plan.updates)}u/{len(plan.deletes)}d"
        )
    finally:
        await s.rollback()
        await s.close()


# -------------------------------------------------------------------------- drafts


async def test_draft_edits_are_invisible_to_availability(world):
    """The whole point of a draft (TDD §14.3): an admin can move and add desks all day
    and nobody booking a desk sees any of it."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)

        layout.resources[0].position = Position(x=0.9, y=0.9)
        layout.resources.append(
            LayoutResource(key="new-1", code="A-99", position=Position(x=0.5, y=0.5))
        )
        await layout_service.save_draft(s, floor, layout, actor)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        live = list(await s.scalars(select(Resource).where(Resource.floor_id == world.floor)))
        assert len(live) == 3, "a draft created a live resource"
        moved = next(r for r in live if r.id == world.desks[0])
        assert moved.position["x"] == pytest.approx(0.1), "a draft moved a live desk"

        # ...and reopening the editor shows the edit, not the live rows.
        floor = await _floor(s, world.floor)
        layout, is_draft = await layout_service.current_layout(s, floor)
        assert is_draft is True
        assert len(layout.resources) == 4
    finally:
        await s.rollback()
        await s.close()


async def test_duplicate_codes_are_refused_with_the_offending_code(world):
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources.append(
            LayoutResource(key="dup", code="a-00", position=Position(x=0.4, y=0.4))
        )

        with pytest.raises(InvalidLayout) as exc:
            await layout_service.save_draft(s, floor, layout, actor)
        codes = {v.code for v in exc.value.violations}
        assert "layout.duplicate_code" in codes, "case-different codes must still clash"
    finally:
        await s.rollback()
        await s.close()


async def test_code_taken_on_another_floor_of_the_same_site_is_named(world):
    """`UNIQUE (site_id, code)` spans the site. Without this check the admin gets an
    IntegrityError on publish and no idea which of 300 desks caused it."""
    s = await _session(world.org)
    try:
        s.add(
            Resource(
                id=uuid7(),
                organization_id=world.org,
                site_id=world.site,
                floor_id=world.other_floor,
                kind="desk",
                code="B-01",
                position={"x": 0.1, "y": 0.1},
                capacity=1,
                attributes={},
            )
        )
        await s.flush()

        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources.append(
            LayoutResource(key="clash", code="B-01", position=Position(x=0.4, y=0.4))
        )

        with pytest.raises(InvalidLayout) as exc:
            await layout_service.save_draft(s, floor, layout, actor)
        assert exc.value.violations[0].params["code"] == "B-01"
    finally:
        await s.rollback()
        await s.close()


async def test_unknown_attributes_are_refused(world):
    """`attributes` is jsonb so new resource kinds need no migration; that is only safe
    if a typo cannot create a desk that silently fails every filter."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources[0].attributes = {"monitor": 2}  # not "monitors"

        with pytest.raises(InvalidLayout) as exc:
            await layout_service.save_draft(s, floor, layout, actor)
        assert exc.value.violations[0].code == "layout.invalid_attributes"
    finally:
        await s.rollback()
        await s.close()


# ------------------------------------------------------------------------ publish


async def test_publish_applies_creates_updates_and_deletes(world):
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)

        layout.resources[0].position = Position(x=0.75, y=0.25)
        layout.resources[0].attributes = {"monitors": 2, "sit_stand": True}
        del layout.resources[2]
        layout.zones.append(
            LayoutZone(
                key="z-new",
                name="Engineering",
                polygon=[(0.1, 0.1), (0.9, 0.1), (0.9, 0.9)],
                color="#4F7DF3",
            )
        )
        layout.resources.append(
            LayoutResource(
                key="new-1", code="A-10", position=Position(x=0.5, y=0.5), zone_key="z-new"
            )
        )

        plan = await layout_service.publish(s, floor, layout, actor)
        assert (len(plan.creates), len(plan.updates), len(plan.deletes)) == (1, 2, 1)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        live = {
            r.code: r
            for r in await s.scalars(
                select(Resource)
                .where(Resource.floor_id == world.floor)
                .where(Resource.status == "active")
            )
        }
        assert set(live) == {"A-00", "A-01", "A-10"}
        assert live["A-00"].position["x"] == pytest.approx(0.75)
        assert live["A-00"].attributes["monitors"] == 2
        # Defaults are filled in, so a filter on `dock` matches rather than missing.
        assert live["A-00"].attributes["dock"] == "none"

        zone = await s.scalar(select(Zone).where(Zone.floor_id == world.floor))
        assert zone is not None and zone.name == "Engineering"
        assert live["A-10"].zone_id == zone.id, "a resource must attach to a zone created"
        " in the same publish"

        floor = await _floor(s, world.floor)
        assert floor.published_at is not None
    finally:
        await s.rollback()
        await s.close()


async def test_publish_regenerates_the_draft_with_real_ids(world):
    """After publishing, the editor must not still be holding `id: null` for a desk that
    now exists — the next publish would create it a second time."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources.append(
            LayoutResource(key="new-1", code="A-10", position=Position(x=0.5, y=0.5))
        )
        await layout_service.save_draft(s, floor, layout, actor)
        await layout_service.publish(s, floor, layout, actor)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        reopened, is_draft = await layout_service.current_layout(s, floor)
        assert is_draft is True
        assert all(r.id is not None for r in reopened.resources)

        plan = await layout_service.build_plan(s, floor, reopened)
        assert plan.is_empty, "republishing an unchanged draft would duplicate resources"
    finally:
        await s.rollback()
        await s.close()


async def test_publish_blocks_on_orphaned_bookings_until_accepted(world):
    """TDD §14.3: publishing a floor that would orphan bookings warns with the count."""
    monday = next_monday()
    s = await _session(world.org)
    try:
        await create_booking(
            s,
            actor=await _user(s, world.user),
            request=BookingRequest(resource_id=world.desks[2], local_date=monday),
        )
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources = [r for r in layout.resources if r.id != world.desks[2]]

        preview = await layout_service.build_plan(s, floor, layout)
        assert preview.affected_bookings == 1
        assert preview.orphans[0].code == "A-02"
        assert preview.orphans[0].reason == "deleted"

        with pytest.raises(PublishBlocked) as exc:
            await layout_service.publish(s, floor, layout, actor)
        assert exc.value.violations[0].params["bookings"] == 1
        assert exc.value.violations[0].params["resources"] == ["A-02"]
    finally:
        await s.rollback()
        await s.close()


async def test_accepted_orphans_are_cancelled_and_notified_not_deleted(world):
    """Removing a booked desk must cancel through the booking service, not delete rows.

    `bookings.resource_id` cascades, so a hard delete would erase the history that
    utilization reporting is built on — and the person who lost their desk would never
    be told, because the outbox event is written by cancellation.
    """
    monday = next_monday()
    s = await _session(world.org)
    try:
        booking = await create_booking(
            s,
            actor=await _user(s, world.user),
            request=BookingRequest(resource_id=world.desks[2], local_date=monday),
        )
        booking_id = booking.id
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources = [r for r in layout.resources if r.id != world.desks[2]]
        await layout_service.publish(s, floor, layout, actor, accept_orphans=True)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        stored = await s.scalar(select(Booking).where(Booking.id == booking_id))
        assert stored is not None, "publishing destroyed booking history"
        assert stored.status == BookingStatus.cancelled.value

        retired = await s.scalar(select(Resource).where(Resource.id == world.desks[2]))
        assert retired is not None and retired.status == "retired"
        assert retired.bookable is False

        events = list(
            await s.scalars(
                select(Outbox)
                .where(Outbox.aggregate_id == booking_id)
                .where(Outbox.event_type == "booking.cancelled")
            )
        )
        assert events, "nobody was told their booking was cancelled"

        # ...and the retired desk is gone from the editor and from availability.
        floor = await _floor(s, world.floor)
        reopened, _ = await layout_service.current_layout(s, floor)
        assert all(r.id != world.desks[2] for r in reopened.resources)
    finally:
        await s.rollback()
        await s.close()


async def test_unbooked_desk_is_deleted_outright(world):
    """The common case — an admin fixing a mistake five minutes after making it —
    should not leave retired rows lying around forever."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        removed = world.desks[1]
        layout.resources = [r for r in layout.resources if r.id != removed]
        await layout_service.publish(s, floor, layout, actor)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        assert await s.scalar(select(Resource).where(Resource.id == world.desks[1])) is None
    finally:
        await s.rollback()
        await s.close()


async def test_moving_a_desk_keeps_its_bookings(world):
    """A desk's identity is its row, not its coordinates. Dragging one two metres left
    must not be treated as destroying it and creating another."""
    monday = next_monday()
    s = await _session(world.org)
    try:
        booking = await create_booking(
            s,
            actor=await _user(s, world.user),
            request=BookingRequest(resource_id=world.desks[0], local_date=monday),
        )
        booking_id = booking.id
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        target = next(r for r in layout.resources if r.id == world.desks[0])
        target.position = Position(x=0.05, y=0.95)

        plan = await layout_service.build_plan(s, floor, layout)
        assert plan.affected_bookings == 0

        await layout_service.publish(s, floor, layout, actor)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        stored = await s.scalar(select(Booking).where(Booking.id == booking_id))
        assert stored.status == BookingStatus.confirmed.value
    finally:
        await s.rollback()
        await s.close()


async def test_taking_a_desk_out_of_service_cancels_its_bookings(world):
    """FR-8.6. Same obligation as removal: the person holding it has to be told."""
    monday = next_monday()
    s = await _session(world.org)
    try:
        booking = await create_booking(
            s,
            actor=await _user(s, world.user),
            request=BookingRequest(resource_id=world.desks[0], local_date=monday),
        )
        booking_id = booking.id
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        target = next(r for r in layout.resources if r.id == world.desks[0])
        target.bookable = False
        target.out_of_service_reason = "Broken monitor arm"

        plan = await layout_service.build_plan(s, floor, layout)
        assert plan.orphans[0].reason == "unbookable"

        await layout_service.publish(s, floor, layout, actor, accept_orphans=True)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        stored = await s.scalar(select(Booking).where(Booking.id == booking_id))
        assert stored.status == BookingStatus.cancelled.value
        assert stored.cancel_reason == "Broken monitor arm"
    finally:
        await s.rollback()
        await s.close()


async def test_past_bookings_do_not_block_an_edit(world):
    """A desk that was booked last month still happened; that is not a reason to stop
    an admin removing it today."""
    s = await _session(world.org)
    try:
        s.add(
            Booking(
                id=uuid7(),
                organization_id=world.org,
                resource_id=world.desks[1],
                site_id=world.site,
                user_id=world.user,
                booked_by_user_id=world.user,
                time_range=Range(
                    now_utc() - timedelta(days=30),
                    now_utc() - timedelta(days=29),
                    bounds="[)",
                ),
                local_date=now_utc().date() - timedelta(days=30),
                status=BookingStatus.completed.value,
                created_at=now_utc(),
            )
        )
        await s.flush()

        floor = await _floor(s, world.floor)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources = [r for r in layout.resources if r.id != world.desks[1]]

        plan = await layout_service.build_plan(s, floor, layout)
        assert plan.affected_bookings == 0

        # ...but the row is still retired rather than deleted, so the history survives.
        await layout_service.publish(s, floor, layout, await _user(s, world.user))
        retired = await s.scalar(select(Resource).where(Resource.id == world.desks[1]))
        assert retired.status == "retired"
    finally:
        await s.rollback()
        await s.close()


async def test_aspect_ratio_change_is_flagged(world):
    """TDD §14.2: a replacement plan that changes aspect ratio prompts the admin to
    re-verify rather than silently distorting every position."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        floor.plan_width_px, floor.plan_height_px = 2400, 1600  # 1.5
        wide = FloorPlanAsset(
            id=uuid7(),
            organization_id=world.org,
            original_key="k",
            rendered_key="k",
            width_px=2400,
            height_px=1000,  # 2.4
            content_type="image/png",
        )
        s.add(wide)
        await s.flush()

        layout, _ = await layout_service.current_layout(s, floor)
        layout.plan_asset_id = wide.id
        plan = await layout_service.build_plan(s, floor, layout)
        assert plan.aspect_ratio_change == (1.5, 2.4)
    finally:
        await s.rollback()
        await s.close()


async def test_discard_draft_restores_the_live_layout(world):
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources = []
        await layout_service.save_draft(s, floor, layout, actor)

        assert await layout_service.discard_draft(s, floor) is True
        restored, is_draft = await layout_service.current_layout(s, floor)
        assert is_draft is False
        assert len(restored.resources) == 3
    finally:
        await s.rollback()
        await s.close()


async def test_a_draft_belongs_to_one_tenant(world, org_b, session_for):
    """floor_drafts is org-scoped like everything else; the RLS sweep in
    test_tenant_isolation covers the table, this covers the service path."""
    s = await _session(world.org)
    try:
        floor = await _floor(s, world.floor)
        actor = await _user(s, world.user)
        layout, _ = await layout_service.current_layout(s, floor)
        layout.resources[0].position = Position(x=0.99, y=0.99)
        await layout_service.save_draft(s, floor, layout, actor)
        await s.commit()
    finally:
        await s.close()

    async with session_for(org_b) as s:
        from app.models import FloorDraft

        assert await s.scalar(select(Floor).where(Floor.id == world.floor)) is None
        assert list(await s.scalars(select(FloorDraft))) == []
