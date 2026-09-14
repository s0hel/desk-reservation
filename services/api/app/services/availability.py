"""Availability queries (TDD §10.1).

One query serves the floor plan, the list view and the filter UI. The GiST index created
by the booking exclusion constraint serves the lateral join directly, so this stays cheap
under the Monday-morning read spike.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

AVAILABILITY_SQL = text("""
    SELECT r.id, r.code, r.name, r.kind, r.capacity, r.position, r.attributes,
           r.zone_id, r.bookable, r.out_of_service_reason, r.assigned_to_user_id,
           b.user_id AS occupied_by, b.id AS booking_id
    FROM resources r
    LEFT JOIN LATERAL (
        SELECT id, user_id FROM bookings
        WHERE resource_id = r.id
          AND status IN ('confirmed', 'checked_in')
          AND time_range && tstzrange(:window_start, :window_end, '[)')
        LIMIT 1
    ) b ON TRUE
    WHERE r.floor_id = :floor_id
      AND r.status = 'active'
      -- Casts are required, not cosmetic: a parameter appearing only in an
      -- "IS NULL OR ..." guard gives asyncpg nothing to infer a type from, and the
      -- query fails with AmbiguousParameterError. (Note also that text() scans SQL
      -- comments for bind parameters, so a colon-prefixed name here would be parsed
      -- as one.)
      AND (CAST(:kind AS text) IS NULL OR r.kind = CAST(:kind AS text))
      AND (CAST(:min_capacity AS integer) IS NULL OR r.capacity >= CAST(:min_capacity AS integer))
      AND (CAST(:filters AS jsonb) IS NULL OR r.attributes @> CAST(:filters AS jsonb))
    ORDER BY r.code
""")


@dataclass(frozen=True)
class ResourceAvailability:
    id: uuid.UUID
    code: str
    name: str | None
    kind: str
    capacity: int
    position: dict
    attributes: dict
    zone_id: uuid.UUID | None
    bookable: bool
    out_of_service_reason: str | None
    assigned_to_user_id: uuid.UUID | None
    occupied_by: uuid.UUID | None
    booking_id: uuid.UUID | None

    @property
    def available(self) -> bool:
        return self.bookable and self.occupied_by is None


async def floor_availability(
    session: AsyncSession,
    *,
    floor_id: uuid.UUID,
    window_start: datetime,
    window_end: datetime,
    kind: str | None = None,
    min_capacity: int | None = None,
    filters: str | None = None,
) -> list[ResourceAvailability]:
    rows = await session.execute(
        AVAILABILITY_SQL,
        {
            "floor_id": floor_id,
            "window_start": window_start,
            "window_end": window_end,
            "kind": kind,
            "min_capacity": min_capacity,
            "filters": filters,
        },
    )
    return [ResourceAvailability(**dict(r)) for r in rows.mappings()]


async def suggest_alternative(
    session: AsyncSession,
    *,
    floor_id: uuid.UUID,
    window_start: datetime,
    window_end: datetime,
    kind: str,
    exclude: uuid.UUID,
) -> ResourceAvailability | None:
    """The next-best resource, so a 409 can offer a one-tap alternative (TDD §10.2)
    rather than just telling the user they lost the race."""
    for r in await floor_availability(
        session,
        floor_id=floor_id,
        window_start=window_start,
        window_end=window_end,
        kind=kind,
    ):
        if r.id != exclude and r.available:
            return r
    return None


WEEK_SQL = text("""
    WITH w(idx, ws, we) AS (
        SELECT * FROM unnest(
            CAST(:idx AS int[]), CAST(:starts AS timestamptz[]), CAST(:ends AS timestamptz[])
        )
    )
    SELECT w.idx AS idx,
           count(r.id) AS total,
           count(r.id) FILTER (WHERE r.bookable AND b.id IS NULL) AS available
    FROM w
    CROSS JOIN resources r
    LEFT JOIN LATERAL (
        SELECT id FROM bookings
        WHERE resource_id = r.id
          AND status IN ('confirmed', 'checked_in')
          AND time_range && tstzrange(w.ws, w.we, '[)')
        LIMIT 1
    ) b ON TRUE
    WHERE r.site_id = :site_id
      AND r.status = 'active'
      AND (CAST(:kind AS text) IS NULL OR r.kind = CAST(:kind AS text))
    GROUP BY w.idx
""")


@dataclass(frozen=True)
class DayCount:
    total: int
    available: int


async def week_counts(
    session: AsyncSession,
    *,
    site_id: uuid.UUID,
    windows: dict[int, tuple[datetime, datetime]],
    kind: str | None = None,
) -> dict[int, DayCount]:
    """Free-vs-total for several days at one site, in a single round trip.

    The home screen shows a week at once (FR-2.1), and seven sequential availability
    calls on app open is exactly the Monday-morning read spike the schema was shaped to
    survive — so the days are unnested into one query rather than looped. Closed days
    are simply absent from `windows`: the caller already knows they are closed, and
    asking the database about a day the site does not open is meaningless.
    """
    if not windows:
        return {}
    idx = sorted(windows)
    rows = await session.execute(
        WEEK_SQL,
        {
            "idx": idx,
            "starts": [windows[i][0] for i in idx],
            "ends": [windows[i][1] for i in idx],
            "site_id": site_id,
            "kind": kind,
        },
    )
    return {r.idx: DayCount(total=r.total, available=r.available) for r in rows}
