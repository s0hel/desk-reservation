"""The exclusion constraint is the product's correctness core (TDD §6.4, §20).

This runs on every PR, not nightly: a regression here is a Monday-morning incident
where two people are sold the same desk.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from app.db.session import SessionFactory, _apply_tenant

DAY = datetime(2026, 9, 14, 7, 0, tzinfo=UTC)


async def _fixture_resource(session_for, org_id) -> tuple[uuid.UUID, uuid.UUID, list[uuid.UUID]]:
    site_id, floor_id, resource_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    users = [uuid.uuid4() for _ in range(8)]
    async with session_for(org_id) as s:
        await s.execute(
            text("""INSERT INTO sites (id, organization_id, name, timezone)
                    VALUES (:i,:o,'T','Europe/Berlin')"""),
            {"i": site_id, "o": org_id},
        )
        await s.execute(
            text("""INSERT INTO floors (id, organization_id, site_id, name)
                    VALUES (:i,:o,:s,'F1')"""),
            {"i": floor_id, "o": org_id, "s": site_id},
        )
        await s.execute(
            text("""INSERT INTO resources (id, organization_id, site_id, floor_id, kind, code)
                    VALUES (:i,:o,:s,:f,'desk','A-01')"""),
            {"i": resource_id, "o": org_id, "s": site_id, "f": floor_id},
        )
        for n, u in enumerate(users):
            await s.execute(
                text("""INSERT INTO users (id, organization_id, email, display_name)
                        VALUES (:i,:o,:e,:d)"""),
                {"i": u, "o": org_id, "e": f"u{n}-{u.hex[:6]}@t.example", "d": f"U{n}"},
            )
    return site_id, resource_id, users


async def _book(org_id, site_id, resource_id, user_id, start, end) -> bool:
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, org_id)
        try:
            await s.execute(
                text("""INSERT INTO bookings
                        (id, organization_id, resource_id, site_id, user_id, booked_by_user_id,
                         time_range, local_date, status)
                        VALUES (:i,:o,:r,:s,:u,:u,
                                tstzrange(:a,:b,'[)'), :d, 'confirmed')"""),
                {
                    "i": uuid.uuid4(),
                    "o": org_id,
                    "r": resource_id,
                    "s": site_id,
                    "u": user_id,
                    "a": start,
                    "b": end,
                    "d": start.date(),
                },
            )
            await s.commit()
            return True
        except Exception:
            await s.rollback()
            return False


async def test_exactly_one_of_eight_concurrent_bookings_wins(org_a, session_for):
    site_id, resource_id, users = await _fixture_resource(session_for, org_a)
    end = DAY + timedelta(hours=10)

    results = await asyncio.gather(
        *[_book(org_a, site_id, resource_id, u, DAY, end) for u in users]
    )
    assert sum(results) == 1, f"expected exactly one winner, got {sum(results)}"


async def test_half_open_ranges_allow_back_to_back_bookings(org_a, session_for):
    """A booking ending at 12:00 and one starting at 12:00 must not conflict."""
    site_id, resource_id, users = await _fixture_resource(session_for, org_a)
    noon = DAY + timedelta(hours=5)
    assert await _book(org_a, site_id, resource_id, users[0], DAY, noon)
    assert await _book(org_a, site_id, resource_id, users[1], noon, noon + timedelta(hours=5))


async def test_cancelled_bookings_stop_blocking(org_a, session_for):
    site_id, resource_id, users = await _fixture_resource(session_for, org_a)
    end = DAY + timedelta(hours=10)
    assert await _book(org_a, site_id, resource_id, users[0], DAY, end)
    assert not await _book(org_a, site_id, resource_id, users[1], DAY, end)

    async with session_for(org_a) as s:
        await s.execute(
            text("UPDATE bookings SET status='cancelled' WHERE resource_id=:r"), {"r": resource_id}
        )

    assert await _book(org_a, site_id, resource_id, users[1], DAY, end), (
        "the partial WHERE clause should release the slot once cancelled"
    )


@pytest.mark.parametrize("overlap_hours", [1, 5, 9])
async def test_partial_overlaps_are_rejected(org_a, session_for, overlap_hours):
    site_id, resource_id, users = await _fixture_resource(session_for, org_a)
    assert await _book(org_a, site_id, resource_id, users[0], DAY, DAY + timedelta(hours=10))
    assert not await _book(
        org_a,
        site_id,
        resource_id,
        users[1],
        DAY + timedelta(hours=overlap_hours),
        DAY + timedelta(hours=overlap_hours + 4),
    )
