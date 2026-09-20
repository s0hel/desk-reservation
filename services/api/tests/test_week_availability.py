"""The home screen's week query (FR-2.1).

Exercised against the real database rather than mocked, because the whole point of
`week_counts` is that it answers seven days in one round trip through the same GiST
index the booking path uses — a Python reimplementation would prove nothing.
"""

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.api.v1.bookings import site_week_availability
from app.core.ids import uuid7
from app.core.time import materialize_opening_hours
from app.db.session import SessionFactory, _apply_tenant
from app.models import Floor, Organization, Resource, Site, User
from app.services.availability import week_counts
from app.services.booking import BookingRequest, create_booking

MONDAY = date(2026, 9, 14)
# Closed at the weekend, which is what makes "shut" and "full" distinguishable.
HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}


class Fixture:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    desks: list[uuid.UUID]
    user: uuid.UUID


@pytest.fixture
async def world(session_for) -> Fixture:
    f = Fixture()
    f.org = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, f.org)
        s.add(Organization(id=f.org, name="w", slug=f"w-{f.org.hex[:8]}"))
        await s.flush()

        site = Site(
            id=uuid7(),
            organization_id=f.org,
            name="HQ",
            timezone="Europe/Berlin",
            opening_hours=HOURS,
        )
        s.add(site)
        await s.flush()
        floor = Floor(id=uuid7(), organization_id=f.org, site_id=site.id, name="F1")
        s.add(floor)
        await s.flush()
        f.site, f.floor = site.id, floor.id

        f.desks = []
        for i in range(4):
            r = Resource(
                id=uuid7(),
                organization_id=f.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="desk",
                code=f"D-{i:02d}",
                capacity=1,
                attributes={},
                # One desk is out of service: it must count towards `total` but never
                # towards `available`, or the strip will promise a seat that cannot be
                # booked.
                bookable=i != 3,
                out_of_service_reason=None if i != 3 else "broken monitor arm",
            )
            s.add(r)
            f.desks.append(r.id)

        s.add(
            Resource(
                id=uuid7(),
                organization_id=f.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="room",
                code="R-01",
                capacity=6,
                attributes={},
            )
        )

        user = User(
            id=uuid7(),
            organization_id=f.org,
            email=f"u-{f.org.hex[:6]}@w.example",
            display_name="Week Watcher",
            home_site_id=site.id,
        )
        s.add(user)
        f.user = user.id
        await s.commit()
    return f


async def _session(org):
    s = SessionFactory()
    await s.begin()
    await _apply_tenant(s, org)
    return s


def _windows(site_tz: str, hours: dict, days: list[date]) -> dict[int, tuple]:
    out = {}
    for i, day in enumerate(days):
        resolved = materialize_opening_hours(hours, site_tz, day)
        if resolved is not None:
            out[i] = resolved
    return out


async def test_counts_every_open_day_in_one_query(world):
    days = [MONDAY + timedelta(days=i) for i in range(7)]
    s = await _session(world.org)
    try:
        counts = await week_counts(
            s,
            site_id=world.site,
            windows=_windows("Europe/Berlin", HOURS, days),
            kind="desk",
        )
        # Mon-Fri are indices 0-4; Sat and Sun never reach the query.
        assert sorted(counts) == [0, 1, 2, 3, 4]
        for i in range(5):
            assert counts[i].total == 4
            # The out-of-service desk is counted, but not as free.
            assert counts[i].available == 3
    finally:
        await s.rollback()
        await s.close()


async def test_kind_filter_separates_desks_from_rooms(world):
    days = [MONDAY]
    windows = _windows("Europe/Berlin", HOURS, days)
    s = await _session(world.org)
    try:
        rooms = await week_counts(s, site_id=world.site, windows=windows, kind="room")
        both = await week_counts(s, site_id=world.site, windows=windows, kind=None)
        assert rooms[0].total == 1
        assert both[0].total == 5
    finally:
        await s.rollback()
        await s.close()


async def test_a_booking_only_consumes_its_own_day(world):
    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))
        await create_booking(
            s,
            actor=user,
            request=BookingRequest(
                resource_id=world.desks[0],
                local_date=MONDAY,
                slot="full_day",
                idempotency_key=str(uuid7()),
            ),
        )
        await s.commit()
    finally:
        await s.close()

    days = [MONDAY + timedelta(days=i) for i in range(7)]
    s = await _session(world.org)
    try:
        counts = await week_counts(
            s,
            site_id=world.site,
            windows=_windows("Europe/Berlin", HOURS, days),
            kind="desk",
        )
        assert counts[0].available == 2
        assert counts[1].available == 3
    finally:
        await s.rollback()
        await s.close()


async def test_closed_days_are_shut_not_full(world):
    """A weekend must not arrive as "0 of 0 free", which reads as a full office."""
    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))
        out = await site_week_availability(
            site_id=world.site, session=s, user=user, start=MONDAY, days=7, kind="desk"
        )
        assert [d.local_date for d in out.days] == [MONDAY + timedelta(days=i) for i in range(7)]
        assert [d.is_open for d in out.days] == [True] * 5 + [False, False]

        saturday = out.days[5]
        assert (saturday.total, saturday.available) == (0, 0)
        assert out.site_timezone == "Europe/Berlin"
    finally:
        await s.rollback()
        await s.close()


async def test_my_booking_is_attached_to_its_day(world):
    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))
        await create_booking(
            s,
            actor=user,
            request=BookingRequest(
                resource_id=world.desks[1],
                local_date=MONDAY + timedelta(days=2),
                slot="full_day",
                idempotency_key=str(uuid7()),
            ),
        )
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))
        out = await site_week_availability(
            site_id=world.site, session=s, user=user, start=MONDAY, days=7, kind="desk"
        )
        assert out.days[0].my_booking is None
        booked = out.days[2].my_booking
        assert booked is not None
        # Flattened on purpose: the home screen must name the desk and link to its
        # floor without a second call.
        assert booked.resource_code == "D-01"
        assert booked.floor_id == world.floor
        assert booked.floor_name == "F1"
    finally:
        await s.rollback()
        await s.close()


async def test_a_booking_at_another_site_is_not_this_sites_answer(world):
    """The user's week at Tampa must not report the desk they hold in Berlin.

    Unreachable while the app only ever asked about one site; it stopped being
    unreachable the moment a user could have a home site they chose (FR-1.9), and it
    showed up immediately — a second site's home screen naming a desk on the first
    site's floor, with a "show me on the plan" link that crossed buildings.
    """
    other_site_id = uuid7()
    other_desk_id = uuid7()

    s = await _session(world.org)
    try:
        s.add(
            Site(
                id=other_site_id,
                organization_id=world.org,
                name="Tampa",
                timezone="America/New_York",
                opening_hours=HOURS,
            )
        )
        await s.flush()
        other_floor = Floor(id=uuid7(), organization_id=world.org, site_id=other_site_id, name="T1")
        s.add(other_floor)
        await s.flush()
        s.add(
            Resource(
                id=other_desk_id,
                organization_id=world.org,
                site_id=other_site_id,
                floor_id=other_floor.id,
                kind="desk",
                code="T-01",
                capacity=1,
                attributes={},
            )
        )
        await s.commit()
    finally:
        await s.close()

    # One booking at the ORIGINAL site, on the Tuesday.
    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))
        await create_booking(
            s,
            actor=user,
            request=BookingRequest(
                resource_id=world.desks[0],
                local_date=MONDAY + timedelta(days=1),
                slot="full_day",
                idempotency_key=str(uuid7()),
            ),
        )
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        user = await s.scalar(select(User).where(User.id == world.user))

        here = await site_week_availability(
            site_id=world.site, session=s, user=user, start=MONDAY, days=7, kind="desk"
        )
        assert here.days[1].my_booking is not None, "the booking's own site still reports it"

        there = await site_week_availability(
            site_id=other_site_id, session=s, user=user, start=MONDAY, days=7, kind="desk"
        )
        assert [d.my_booking for d in there.days] == [None] * 7
    finally:
        await s.rollback()
        await s.close()
