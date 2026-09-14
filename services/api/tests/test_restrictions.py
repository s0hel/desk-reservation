"""Zone permissions and blackouts (FR-6.4, FR-6.5).

The decision functions are pure, so most of this is table-driven and fast. The two
integration tests at the end are the ones that matter most: they assert that a booking
is actually refused, and that the availability query refuses the *same* desk — because
until this change the editor could publish a restricted zone that nothing enforced, and
the way that regresses is for one of the two callers to grow its own copy of the rule.
"""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.api.v1.admin import BlackoutIn, create_blackout, preview_blackout
from app.api.v1.bookings import floor_availability as floor_availability_endpoint
from app.core.errors import PolicyViolation
from app.core.ids import uuid7
from app.db.session import SessionFactory, _apply_tenant
from app.models import (
    Blackout,
    Booking,
    Floor,
    Group,
    GroupMember,
    Organization,
    Outbox,
    Resource,
    Site,
    User,
    Zone,
    ZonePermission,
)
from app.services import restrictions
from app.services.booking import BookingRequest, create_booking

MONDAY = date(2026, 9, 14)
HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}
BERLIN = "Europe/Berlin"

DESIGN = uuid.uuid4()
ENGINEERING = uuid.uuid4()


def perm(mode: str, group_id: uuid.UUID, opens_at: time | None = None):
    return SimpleNamespace(mode=mode, group_id=group_id, opens_at_local=opens_at)


def at_berlin(hour: int, minute: int = 0) -> datetime:
    """A UTC instant that is `hour` local in Berlin on the Monday. September is CEST,
    so local is UTC+2."""
    return datetime(2026, 9, 14, hour - 2, minute, tzinfo=UTC)


# ── FR-6.4 zone access, as a pure decision ────────────────────────────────────


#: A neutral mid-morning instant, before any cut-off these tests use.
NINE_AM = at_berlin(9)


def _zone(permissions, member_of, now=NINE_AM):
    return restrictions.zone_violation(
        permissions,
        member_of=frozenset(member_of),
        site_timezone=BERLIN,
        local_date=MONDAY,
        now=now,
    )


def test_a_zone_with_no_permissions_is_open():
    assert _zone([], member_of=[]) is None


def test_exclusive_admits_members_and_refuses_everyone_else():
    rows = [perm("exclusive", DESIGN)]
    assert _zone(rows, member_of=[DESIGN]) is None
    refusal = _zone(rows, member_of=[ENGINEERING])
    assert refusal is not None
    assert refusal.code == "policy.zone_not_permitted"


def test_preferred_is_a_ranking_hint_and_never_blocks():
    """It exists for auto-assign (FR-2.9). Treating it as an access rule would let a
    `preferred` row silently widen an `exclusive` row on the same zone."""
    assert _zone([perm("preferred", DESIGN)], member_of=[]) is None
    # And it must not rescue an outsider from an exclusive row beside it.
    both = [perm("exclusive", DESIGN), perm("preferred", ENGINEERING)]
    assert _zone(both, member_of=[ENGINEERING]) is not None


def test_open_after_holds_the_zone_until_the_cut_off_then_releases_it():
    rows = [perm("open_after", DESIGN, time(14, 0))]
    early = _zone(rows, member_of=[ENGINEERING], now=at_berlin(13, 59))
    assert early is not None
    assert early.code == "policy.zone_not_yet_open"
    assert early.params["opens_at"] == "14:00"
    assert _zone(rows, member_of=[ENGINEERING], now=at_berlin(14, 0)) is None


def test_open_after_admits_its_own_group_at_any_hour():
    rows = [perm("open_after", DESIGN, time(14, 0))]
    assert _zone(rows, member_of=[DESIGN], now=at_berlin(6)) is None


def test_the_cut_off_is_wall_clock_at_the_site_not_utc():
    """September in Berlin is UTC+2. A rule that compared naive times would release the
    zone two hours early, every day, and look correct in winter."""
    rows = [perm("open_after", DESIGN, time(14, 0))]
    # 12:30 UTC is 14:30 in Berlin — open.
    assert _zone(rows, member_of=[], now=datetime(2026, 9, 14, 12, 30, tzinfo=UTC)) is None
    # 11:30 UTC is 13:30 in Berlin — still held.
    assert _zone(rows, member_of=[], now=datetime(2026, 9, 14, 11, 30, tzinfo=UTC)) is not None


def test_combined_modes_are_read_per_row():
    """Held for Design, opened to everyone at 14:00. Collapsing the two rows into one
    membership test gets one of the two answers wrong whichever way it is written."""
    rows = [perm("exclusive", DESIGN), perm("open_after", ENGINEERING, time(14, 0))]
    assert _zone(rows, member_of=[DESIGN], now=at_berlin(8)) is None
    assert _zone(rows, member_of=[ENGINEERING], now=at_berlin(8)) is None
    outsider_early = _zone(rows, member_of=[], now=at_berlin(8))
    assert outsider_early is not None and outsider_early.code == "policy.zone_not_yet_open"
    assert _zone(rows, member_of=[], now=at_berlin(15)) is None


def test_the_earliest_release_is_the_one_reported():
    rows = [
        perm("open_after", DESIGN, time(16, 0)),
        perm("open_after", ENGINEERING, time(13, 30)),
    ]
    refusal = _zone(rows, member_of=[], now=at_berlin(9))
    assert refusal is not None and refusal.params["opens_at"] == "13:30"


# ── FR-6.5 blackouts, as a pure decision ──────────────────────────────────────


def blackout(**kw):
    defaults = dict(
        site_id=None,
        floor_id=None,
        starts_on=MONDAY,
        ends_on=MONDAY,
        reason="Maintenance",
    )
    return SimpleNamespace(**{**defaults, **kw})


def test_a_blackout_covers_every_day_in_its_range_inclusive():
    rows = [blackout(starts_on=MONDAY, ends_on=MONDAY + timedelta(days=2))]
    for offset in range(3):
        assert (
            restrictions.blackout_hit(
                rows, local_date=MONDAY + timedelta(days=offset), floor_id=None
            )
            is not None
        )
    assert (
        restrictions.blackout_hit(rows, local_date=MONDAY + timedelta(days=3), floor_id=None)
        is None
    )


def test_a_floor_blackout_does_not_close_the_rest_of_the_site():
    floor = uuid.uuid4()
    rows = [blackout(floor_id=floor)]
    assert restrictions.blackout_hit(rows, local_date=MONDAY, floor_id=floor) is not None
    assert restrictions.blackout_hit(rows, local_date=MONDAY, floor_id=uuid.uuid4()) is None
    # And asking "is anything closed at this site" must not be answered by one floor.
    assert restrictions.blackout_hit(rows, local_date=MONDAY, floor_id=None) is None


def test_an_org_wide_blackout_reaches_every_floor():
    rows = [blackout()]
    assert restrictions.blackout_hit(rows, local_date=MONDAY, floor_id=uuid.uuid4()) is not None


def test_the_violation_carries_the_admins_reason():
    violation = restrictions.blackout_violation(
        [blackout(reason="Lift replacement")], local_date=MONDAY, floor_id=None
    )
    assert violation is not None
    assert violation.code == "policy.blackout"
    assert violation.params["reason"] == "Lift replacement"
    assert violation.params["date"] == "2026-09-14"


# ── the rules actually bind ───────────────────────────────────────────────────


class World:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    zone: uuid.UUID
    design: uuid.UUID
    open_desk: uuid.UUID
    zoned_desk: uuid.UUID
    insider: uuid.UUID
    outsider: uuid.UUID


@pytest.fixture
async def world(session_for) -> World:
    w = World()
    w.org = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, w.org)
        s.add(Organization(id=w.org, name="z", slug=f"z-{w.org.hex[:8]}"))
        await s.flush()

        site = Site(
            id=uuid7(), organization_id=w.org, name="HQ", timezone=BERLIN, opening_hours=HOURS
        )
        s.add(site)
        await s.flush()
        floor = Floor(id=uuid7(), organization_id=w.org, site_id=site.id, name="F1")
        s.add(floor)
        await s.flush()
        zone = Zone(
            id=uuid7(),
            organization_id=w.org,
            floor_id=floor.id,
            name="Design corner",
            polygon=[[0, 0], [1, 0], [1, 1]],
        )
        s.add(zone)
        design = Group(id=uuid7(), organization_id=w.org, name="Design")
        s.add(design)
        await s.flush()
        w.site, w.floor, w.zone, w.design = site.id, floor.id, zone.id, design.id

        s.add(
            ZonePermission(
                id=uuid7(),
                organization_id=w.org,
                zone_id=zone.id,
                group_id=design.id,
                mode="exclusive",
            )
        )

        for code, zone_id, attr in (
            ("D-OPEN", None, "open_desk"),
            ("D-ZONED", zone.id, "zoned_desk"),
        ):
            r = Resource(
                id=uuid7(),
                organization_id=w.org,
                site_id=site.id,
                floor_id=floor.id,
                zone_id=zone_id,
                kind="desk",
                code=code,
                capacity=1,
                attributes={},
                position={"x": 0.5, "y": 0.5},
            )
            s.add(r)
            setattr(w, attr, r.id)

        for attr, name, in_design in (
            ("insider", "Dana Okafor", True),
            ("outsider", "Priya Raman", False),
        ):
            u = User(
                id=uuid7(),
                organization_id=w.org,
                email=f"{attr}-{w.org.hex[:6]}@z.example",
                display_name=name,
                home_site_id=site.id,
            )
            s.add(u)
            await s.flush()
            if in_design:
                s.add(
                    GroupMember(id=uuid7(), organization_id=w.org, group_id=design.id, user_id=u.id)
                )
            setattr(w, attr, u.id)
        await s.commit()
    return w


async def _session(org):
    s = SessionFactory()
    await s.begin()
    await _apply_tenant(s, org)
    return s


async def _user(s, user_id):
    return await s.scalar(select(User).where(User.id == user_id))


async def _book(s, user_id, desk, day=MONDAY):
    return await create_booking(
        s,
        actor=await _user(s, user_id),
        request=BookingRequest(
            resource_id=desk, local_date=day, slot="full_day", idempotency_key=str(uuid7())
        ),
    )


async def test_an_exclusive_zone_refuses_an_outsiders_booking(world):
    """The gap this change closes: before it, the editor could publish this zone and
    every one of these bookings still succeeded."""
    s = await _session(world.org)
    try:
        with pytest.raises(PolicyViolation) as caught:
            await _book(s, world.outsider, world.zoned_desk)
        assert caught.value.violations[0].code == "policy.zone_not_permitted"
    finally:
        await s.rollback()
        await s.close()


async def test_the_same_zone_admits_its_own_group(world):
    s = await _session(world.org)
    try:
        booking = await _book(s, world.insider, world.zoned_desk)
        assert booking.id is not None
    finally:
        await s.rollback()
        await s.close()


async def test_a_restricted_zone_does_not_restrict_the_rest_of_the_floor(world):
    s = await _session(world.org)
    try:
        booking = await _book(s, world.outsider, world.open_desk)
        assert booking.id is not None
    finally:
        await s.rollback()
        await s.close()


async def test_zone_access_follows_the_subject_not_the_actor(world):
    """A team lead booking for someone else must not lend them their own access."""
    s = await _session(world.org)
    try:
        actor = await _user(s, world.insider)
        with pytest.raises(PolicyViolation) as caught:
            await create_booking(
                s,
                actor=actor,
                request=BookingRequest(
                    resource_id=world.zoned_desk,
                    local_date=MONDAY,
                    slot="full_day",
                    user_id=world.outsider,
                    idempotency_key=str(uuid7()),
                ),
                actor_may_delegate=True,
            )
        codes_seen = {v.code for v in caught.value.violations}
        assert "policy.zone_not_permitted" in codes_seen
    finally:
        await s.rollback()
        await s.close()


async def test_a_blackout_refuses_bookings_for_the_days_it_covers(world):
    s = await _session(world.org)
    try:
        s.add(
            Blackout(
                id=uuid7(),
                organization_id=world.org,
                site_id=world.site,
                starts_on=MONDAY,
                ends_on=MONDAY,
                reason="Lift replacement",
            )
        )
        await s.flush()

        with pytest.raises(PolicyViolation) as caught:
            await _book(s, world.outsider, world.open_desk)
        violation = caught.value.violations[0]
        assert violation.code == "policy.blackout"
        assert violation.params["reason"] == "Lift replacement"

        # The next day is untouched.
        booking = await _book(s, world.outsider, world.open_desk, day=MONDAY + timedelta(days=1))
        assert booking.id is not None
    finally:
        await s.rollback()
        await s.close()


async def test_a_floor_blackout_leaves_other_floors_bookable(world):
    s = await _session(world.org)
    try:
        other = Floor(id=uuid7(), organization_id=world.org, site_id=world.site, name="F2")
        s.add(other)
        await s.flush()
        elsewhere = Resource(
            id=uuid7(),
            organization_id=world.org,
            site_id=world.site,
            floor_id=other.id,
            kind="desk",
            code="E-01",
            capacity=1,
            attributes={},
            position={"x": 0.2, "y": 0.2},
        )
        s.add(elsewhere)
        s.add(
            Blackout(
                id=uuid7(),
                organization_id=world.org,
                site_id=world.site,
                floor_id=world.floor,
                starts_on=MONDAY,
                ends_on=MONDAY,
                reason="Painting",
            )
        )
        await s.flush()

        with pytest.raises(PolicyViolation):
            await _book(s, world.outsider, world.open_desk)
        booking = await _book(s, world.insider, elsewhere.id)
        assert booking.id is not None
    finally:
        await s.rollback()
        await s.close()


# ── availability and the booking rule must agree ──────────────────────────────


async def _availability(s, world, user_id, day=MONDAY):
    return await floor_availability_endpoint(
        floor_id=world.floor,
        session=s,
        user=await _user(s, user_id),
        local_date=day,
    )


async def test_availability_hides_a_restricted_desk_from_an_outsider(world):
    """The whole point of routing both callers through `restrictions`. If availability
    computed this separately, the desk would render green and then refuse — which is
    the bug this work exists to remove, arriving by a different door."""
    s = await _session(world.org)
    try:
        out = await _availability(s, world, world.outsider)
        by_code = {r.code: r for r in out.resources}

        zoned = by_code["D-ZONED"]
        assert zoned.available is False
        assert zoned.restriction is not None
        assert zoned.restriction.code == "policy.zone_not_permitted"
        # `bookable` stays a fact about the desk, not about the viewer.
        assert zoned.bookable is True

        assert by_code["D-OPEN"].available is True
        assert by_code["D-OPEN"].restriction is None
        # The free count must exclude what this person cannot take.
        assert out.available == 1
        assert out.total == 2
    finally:
        await s.rollback()
        await s.close()


async def test_availability_shows_the_same_desk_to_its_own_group(world):
    s = await _session(world.org)
    try:
        out = await _availability(s, world, world.insider)
        zoned = next(r for r in out.resources if r.code == "D-ZONED")
        assert zoned.available is True
        assert zoned.restriction is None
        assert out.available == 2
    finally:
        await s.rollback()
        await s.close()


async def test_availability_refuses_a_blacked_out_day_rather_than_listing_desks(world):
    """Same shape as a closed day, so the client renders it through machinery it has."""
    s = await _session(world.org)
    try:
        s.add(
            Blackout(
                id=uuid7(),
                organization_id=world.org,
                site_id=world.site,
                starts_on=MONDAY,
                ends_on=MONDAY,
                reason="Lift replacement",
            )
        )
        await s.flush()

        with pytest.raises(PolicyViolation) as caught:
            await _availability(s, world, world.outsider)
        assert caught.value.violations[0].code == "policy.blackout"

        # And the following day still lists its desks.
        out = await _availability(s, world, world.outsider, day=MONDAY + timedelta(days=1))
        assert out.total == 2
    finally:
        await s.rollback()
        await s.close()


# ── the admin side of FR-6.5 ──────────────────────────────────────────────────


async def test_preview_counts_what_a_closure_would_break_without_breaking_it(world):
    s = await _session(world.org)
    try:
        await _book(s, world.outsider, world.open_desk)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        preview = await preview_blackout(
            BlackoutIn(site_id=world.site, starts_on=MONDAY, ends_on=MONDAY, reason="Holiday"),
            s,
        )
        assert preview.affected_bookings == 1
        # Nothing created, nothing cancelled: the preview is a question, not an action.
        assert (await s.scalars(select(Blackout))).all() == []
        booking = await s.scalar(select(Booking).where(Booking.resource_id == world.open_desk))
        assert booking.status == "confirmed"
    finally:
        await s.rollback()
        await s.close()


async def test_creating_a_closure_leaves_bookings_alone_unless_asked(world):
    s = await _session(world.org)
    try:
        await _book(s, world.outsider, world.open_desk)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        out = await create_blackout(
            BlackoutIn(site_id=world.site, starts_on=MONDAY, ends_on=MONDAY, reason="Holiday"),
            s,
            await _user(s, world.insider),
        )
        assert out.affected_bookings == 0
    finally:
        await s.close()

    # A fresh session, because the endpoint committed: `SET LOCAL app.org_id` is scoped
    # to the transaction, so reusing this one would query with no tenant set and RLS
    # would correctly return nothing. A real request gets a new session per call.
    s = await _session(world.org)
    try:
        booking = await s.scalar(select(Booking).where(Booking.resource_id == world.open_desk))
        assert booking.status == "confirmed"
    finally:
        await s.rollback()
        await s.close()


async def test_cancelling_goes_through_the_booking_service_so_people_are_told(world):
    """FR-6.5 says "cancels existing bookings *with notice*". A bulk status UPDATE would
    satisfy the first half and quietly skip the second."""
    s = await _session(world.org)
    try:
        await _book(s, world.outsider, world.open_desk)
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        before = len((await s.scalars(select(Outbox))).all())
        out = await create_blackout(
            BlackoutIn(
                site_id=world.site,
                starts_on=MONDAY,
                ends_on=MONDAY,
                reason="Lift replacement",
                cancels_bookings=True,
            ),
            s,
            await _user(s, world.insider),
        )
        assert out.affected_bookings == 1
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        booking = await s.scalar(select(Booking).where(Booking.resource_id == world.open_desk))
        assert booking.status == "cancelled"
        # The notice is the half a bulk UPDATE would silently skip.
        assert len((await s.scalars(select(Outbox))).all()) > before
    finally:
        await s.rollback()
        await s.close()


async def test_a_closure_that_ends_before_it_starts_is_rejected_as_input(world):
    with pytest.raises(ValidationError):
        BlackoutIn(starts_on=MONDAY, ends_on=MONDAY - timedelta(days=1))
