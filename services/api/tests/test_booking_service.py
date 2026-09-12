"""Booking service integration tests (TDD §10.2).

These exercise the real database, because the guarantee under test — that two people
cannot hold the same desk — belongs to the exclusion constraint, not to Python.
"""

import asyncio
import uuid
from datetime import date, timedelta

import pytest

from app.core.errors import PolicyViolation, ResourceUnavailable
from app.core.ids import uuid7
from app.db.session import SessionFactory, _apply_tenant
from app.models import (
    Booking,
    BookingStatus,
    Floor,
    Organization,
    Outbox,
    Resource,
    Site,
    User,
)
from app.policy import codes
from app.services.booking import BookingRequest, cancel_booking, create_booking

MONDAY = date(2026, 9, 14)
HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}


class Fixture:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    desks: list[uuid.UUID]
    room: uuid.UUID
    users: list[uuid.UUID]


@pytest.fixture
async def world(session_for) -> Fixture:
    """A committed tenant: one site, one floor, three desks, a room, four users."""
    f = Fixture()
    f.org = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, f.org)
        s.add(Organization(id=f.org, name="t", slug=f"t-{f.org.hex[:8]}"))
        await s.flush()

        site = Site(
            id=uuid7(),
            organization_id=f.org,
            name="HQ",
            timezone="Europe/Berlin",
            opening_hours=HOURS,
            daily_capacity_cap=None,
        )
        s.add(site)
        await s.flush()
        floor = Floor(id=uuid7(), organization_id=f.org, site_id=site.id, name="F1")
        s.add(floor)
        await s.flush()

        f.site, f.floor = site.id, floor.id
        f.desks = []
        for i in range(3):
            r = Resource(
                id=uuid7(),
                organization_id=f.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="desk",
                code=f"A-{i:02d}",
                capacity=1,
                attributes={},
            )
            s.add(r)
            f.desks.append(r.id)
        room = Resource(
            id=uuid7(),
            organization_id=f.org,
            site_id=site.id,
            floor_id=floor.id,
            kind="room",
            code="R-01",
            capacity=6,
            attributes={},
        )
        s.add(room)
        f.room = room.id

        f.users = []
        for i in range(4):
            u = User(
                id=uuid7(),
                organization_id=f.org,
                email=f"u{i}-{f.org.hex[:6]}@t.example",
                display_name=f"U{i}",
                home_site_id=site.id,
            )
            s.add(u)
            f.users.append(u.id)
        await s.commit()
    return f


async def _session(org):
    s = SessionFactory()
    await s.begin()
    await _apply_tenant(s, org)
    return s


async def _user(s, user_id) -> User:
    return await s.scalar(__import__("sqlalchemy").select(User).where(User.id == user_id))


async def book(world, user_id, resource_id, day=MONDAY, slot="full_day", key=None):
    s = await _session(world.org)
    try:
        booking = await create_booking(
            s,
            actor=await _user(s, user_id),
            request=BookingRequest(
                resource_id=resource_id, local_date=day, slot=slot, idempotency_key=key
            ),
        )
        await s.commit()
        return booking
    finally:
        await s.close()


# ------------------------------------------------------------------ happy path


async def test_creates_a_booking_and_enqueues_its_notification(world):
    from sqlalchemy import select

    booking = await book(world, world.users[0], world.desks[0])
    assert booking.status == BookingStatus.confirmed.value

    s = await _session(world.org)
    events = (await s.scalars(select(Outbox).where(Outbox.aggregate_id == booking.id))).all()
    await s.close()
    # Written in the same transaction as the booking (TDD §15.1) — a confirmed booking
    # can never exist without its notification enqueued.
    assert [e.event_type for e in events] == ["booking.confirmed"]


async def test_half_day_slots_split_at_the_sites_wall_clock(world):
    am = await book(world, world.users[0], world.desks[0], slot="am")
    pm = await book(world, world.users[1], world.desks[0], slot="pm")
    assert am.time_range.upper == pm.time_range.lower  # half-open: no overlap, no gap


# ------------------------------------------------------------------- conflicts


async def test_second_booking_of_the_same_desk_is_refused(world):
    await book(world, world.users[0], world.desks[0])
    with pytest.raises(ResourceUnavailable) as exc:
        await book(world, world.users[1], world.desks[0])
    assert exc.value.violations[0].code == codes.RESOURCE_UNAVAILABLE


async def test_concurrent_bookings_of_one_desk_yield_exactly_one_winner(world):
    """The constraint arbitrates, not application code (TDD §6.4)."""
    results = await asyncio.gather(
        *[book(world, u, world.desks[0]) for u in world.users],
        return_exceptions=True,
    )
    winners = [r for r in results if isinstance(r, Booking)]
    losers = [r for r in results if isinstance(r, ResourceUnavailable)]
    assert len(winners) == 1, f"expected 1 winner, got {len(winners)}"
    assert len(losers) == len(world.users) - 1


async def test_cancelling_frees_the_desk(world):
    first = await book(world, world.users[0], world.desks[0])

    s = await _session(world.org)
    await cancel_booking(s, actor=await _user(s, world.users[0]), booking_id=first.id)
    await s.commit()
    await s.close()

    again = await book(world, world.users[1], world.desks[0])
    assert again.status == BookingStatus.confirmed.value


# ---------------------------------------------------------------- idempotency


async def test_replaying_an_idempotency_key_returns_the_same_booking(world):
    a = await book(world, world.users[0], world.desks[0], key="abc-123")
    b = await book(world, world.users[0], world.desks[0], key="abc-123")
    assert a.id == b.id, "a retried request must not create a second booking"


async def test_different_keys_on_a_taken_desk_still_conflict(world):
    await book(world, world.users[0], world.desks[0], key="k1")
    with pytest.raises(ResourceUnavailable):
        await book(world, world.users[1], world.desks[0], key="k2")


# --------------------------------------------------------------------- policy


async def test_one_desk_per_day_is_enforced(world):
    await book(world, world.users[0], world.desks[0])
    with pytest.raises(PolicyViolation) as exc:
        await book(world, world.users[0], world.desks[1])
    assert exc.value.violations[0].code == codes.ALREADY_BOOKED_TODAY


async def test_a_room_does_not_count_as_the_days_desk(world):
    await book(world, world.users[0], world.desks[0])
    room = await book(world, world.users[0], world.room)
    assert room.status == BookingStatus.confirmed.value


async def test_horizon_refusal_names_the_rule(world):
    with pytest.raises(PolicyViolation) as exc:
        await book(world, world.users[0], world.desks[0], day=MONDAY + timedelta(days=400))
    codes_seen = {v.code for v in exc.value.violations}
    assert codes.HORIZON_EXCEEDED in codes_seen


async def test_booking_a_closed_day_is_refused(world):
    saturday = MONDAY + timedelta(days=5)
    with pytest.raises(PolicyViolation) as exc:
        await book(world, world.users[0], world.desks[0], day=saturday)
    assert exc.value.violations[0].code == codes.OUTSIDE_OPENING_HOURS


# --------------------------------------------------------------- availability


async def test_availability_reflects_bookings_and_filters(world):
    from app.services.availability import floor_availability
    from app.services.booking import resolve_window

    s = await _session(world.org)
    site = await s.scalar(__import__("sqlalchemy").select(Site).where(Site.id == world.site))
    start, end = resolve_window(site, MONDAY, "full_day", None, None)

    before = await floor_availability(
        s, floor_id=world.floor, window_start=start, window_end=end, kind="desk"
    )
    await s.close()
    assert len(before) == 3
    assert all(r.available for r in before)

    await book(world, world.users[0], world.desks[0])

    s = await _session(world.org)
    after = await floor_availability(
        s, floor_id=world.floor, window_start=start, window_end=end, kind="desk"
    )
    rooms = await floor_availability(
        s, floor_id=world.floor, window_start=start, window_end=end, kind="room"
    )
    big = await floor_availability(
        s, floor_id=world.floor, window_start=start, window_end=end, min_capacity=4
    )
    await s.close()

    assert sum(1 for r in after if r.available) == 2
    assert [r.code for r in rooms] == ["R-01"]
    assert [r.code for r in big] == ["R-01"]  # capacity filter excludes the desks
