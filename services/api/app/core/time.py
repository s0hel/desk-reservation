"""The only module permitted to convert between instants and site-local days (TDD §5).

Rules enforced here:
  - every instant is timezone-aware UTC
  - a booking's "day" is defined by the SITE's timezone, never the device's or the server's
  - opening hours are wall-clock + weekday mask, materialized per date so DST is handled
    by the materialization rather than by offset arithmetic
"""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

UTC = UTC


def now_utc() -> datetime:
    return datetime.now(UTC)


def site_tz(timezone_name: str) -> ZoneInfo:
    return ZoneInfo(timezone_name)


def site_day_bounds(timezone_name: str, local_date: date) -> tuple[datetime, datetime]:
    """[start, end) of a site-local calendar day, as UTC instants.

    Correct across DST: a 23- or 25-hour local day produces a 23- or 25-hour UTC range.
    """
    tz = site_tz(timezone_name)
    start = datetime.combine(local_date, time.min, tzinfo=tz)
    end = datetime.combine(local_date + timedelta(days=1), time.min, tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)


def to_local_date(timezone_name: str, instant: datetime) -> date:
    if instant.tzinfo is None:
        raise ValueError("naive datetime: all instants must be timezone-aware (TDD §5)")
    return instant.astimezone(site_tz(timezone_name)).date()


def local_time_to_utc(timezone_name: str, local_date: date, wall: time) -> datetime:
    tz = site_tz(timezone_name)
    return datetime.combine(local_date, wall, tzinfo=tz).astimezone(UTC)


def materialize_opening_hours(
    opening_hours: dict, timezone_name: str, local_date: date
) -> tuple[datetime, datetime] | None:
    """opening_hours: {"mon": ["08:00", "19:00"], ...}. Returns None when closed."""
    key = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][local_date.weekday()]
    window = opening_hours.get(key)
    if not window:
        return None
    opens, closes = (time.fromisoformat(w) for w in window)
    return (
        local_time_to_utc(timezone_name, local_date, opens),
        local_time_to_utc(timezone_name, local_date, closes),
    )
