"""Timezone correctness (TDD §5). These are the bugs that ship silently, so they are
tested across real DST boundaries rather than with round numbers."""

from datetime import UTC, date, datetime

import pytest

from app.core.time import materialize_opening_hours, site_day_bounds, to_local_date

BERLIN = "Europe/Berlin"
LA = "America/Los_Angeles"


def test_day_is_defined_by_site_not_server():
    b_start, b_end = site_day_bounds(BERLIN, date(2026, 3, 10))
    l_start, l_end = site_day_bounds(LA, date(2026, 3, 10))
    assert b_start != l_start
    assert (b_end - b_start).total_seconds() == 24 * 3600
    assert (l_end - l_start).total_seconds() == 24 * 3600


def test_spring_forward_produces_a_23_hour_day():
    # Europe/Berlin DST begins 2026-03-29
    start, end = site_day_bounds(BERLIN, date(2026, 3, 29))
    assert (end - start).total_seconds() == 23 * 3600


def test_fall_back_produces_a_25_hour_day():
    # Europe/Berlin DST ends 2026-10-25
    start, end = site_day_bounds(BERLIN, date(2026, 10, 25))
    assert (end - start).total_seconds() == 25 * 3600


def test_local_date_uses_site_timezone():
    instant = datetime(2026, 9, 11, 23, 30, tzinfo=UTC)
    assert to_local_date(BERLIN, instant) == date(2026, 9, 12)  # already tomorrow in Berlin
    assert to_local_date(LA, instant) == date(2026, 9, 11)


def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError):
        to_local_date(BERLIN, datetime(2026, 9, 11, 12, 0))  # noqa: DTZ001


def test_closed_days_return_none():
    hours = {"mon": ["08:00", "18:00"]}
    assert materialize_opening_hours(hours, BERLIN, date(2026, 9, 14)) is not None  # Monday
    assert materialize_opening_hours(hours, BERLIN, date(2026, 9, 13)) is None  # Sunday
