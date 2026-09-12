"""Policy rules are pure functions, so the matrix is exhaustively testable (TDD §9, §20).

This is where customer-specific requirements will accumulate, so it is where regression
risk concentrates — these run without a database on purpose, so they stay fast enough to
grow into the hundreds.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.policy import codes
from app.policy.context import BookingContext, PolicySet
from app.policy.engine import blocking, evaluate
from app.policy.rules import (
    BookingHorizon,
    DelegationAllowed,
    MaxConcurrentBookings,
    OneDeskPerDay,
    OpeningHours,
    ResourceBookable,
    SiteCapacityCap,
)

UTC = UTC
TODAY = date(2026, 9, 14)  # a Monday
OPEN_HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}


def make_site(**kw):
    defaults = dict(
        id=uuid.uuid4(),
        timezone="Europe/Berlin",
        opening_hours=OPEN_HOURS,
        daily_capacity_cap=None,
    )
    return SimpleNamespace(**{**defaults, **kw})


def make_resource(**kw):
    defaults = dict(
        id=uuid.uuid4(),
        code="4F-A-01",
        kind="desk",
        bookable=True,
        status="active",
        out_of_service_reason=None,
    )
    return SimpleNamespace(**{**defaults, **kw})


def make_ctx(
    *,
    site=None,
    resource=None,
    local_date=TODAY,
    policies=None,
    subject_bookings=(),
    site_bookings_today=0,
    now=None,
    actor=None,
    subject=None,
):
    site = site or make_site()
    subject = subject or SimpleNamespace(id=uuid.uuid4(), organization_id=uuid.uuid4())
    actor = actor or subject
    start = datetime.combine(local_date, datetime.min.time(), tzinfo=UTC) + timedelta(hours=6)
    return BookingContext(
        organization_id=subject.organization_id,
        actor=actor,
        subject=subject,
        site=site,
        resource=resource if resource is not None else make_resource(),
        starts_at=start,
        ends_at=start + timedelta(hours=10),
        local_date=local_date,
        subject_bookings=tuple(subject_bookings),
        site_bookings_today=site_bookings_today,
        policies=policies or PolicySet(),
        now=now or datetime(2026, 9, 14, 6, 0, tzinfo=UTC),
    )


def codes_of(violations):
    return {v.code for v in violations}


# --------------------------------------------------------------------- rules


def test_out_of_service_desk_is_refused_with_the_admins_reason():
    r = make_resource(bookable=False, out_of_service_reason="broken monitor arm")
    result = ResourceBookable().evaluate(make_ctx(resource=r))
    assert not result.allow
    assert result.code == codes.RESOURCE_OUT_OF_SERVICE
    assert result.params["reason"] == "broken monitor arm"


def test_booking_outside_opening_hours_is_refused():
    ctx = make_ctx(site=make_site(opening_hours={"mon": ["09:00", "10:00"]}))
    assert not OpeningHours().evaluate(ctx).allow


def test_closed_day_is_refused():
    ctx = make_ctx(site=make_site(opening_hours={"tue": ["07:00", "20:00"]}))  # Monday booking
    result = OpeningHours().evaluate(ctx)
    assert not result.allow and result.params["closed"] is True


def test_horizon_allows_inside_and_refuses_beyond():
    policies = PolicySet(values={"booking_horizon": {"max_days": 14}})
    assert (
        BookingHorizon()
        .evaluate(make_ctx(local_date=TODAY + timedelta(days=14), policies=policies))
        .allow
    )
    result = BookingHorizon().evaluate(
        make_ctx(local_date=TODAY + timedelta(days=15), policies=policies)
    )
    assert not result.allow
    assert result.params == {"max_days": 14, "requested_days": 15}


def test_max_concurrent_counts_other_days_only():
    """Changing an existing day must not be blocked by the booking it replaces."""
    same_day = SimpleNamespace(local_date=TODAY, site_id=uuid.uuid4())
    policies = PolicySet(values={"max_concurrent_bookings": {"max": 1}})
    assert (
        MaxConcurrentBookings()
        .evaluate(make_ctx(subject_bookings=[same_day], policies=policies))
        .allow
    )

    other_day = SimpleNamespace(local_date=TODAY + timedelta(days=1), site_id=uuid.uuid4())
    assert (
        not MaxConcurrentBookings()
        .evaluate(make_ctx(subject_bookings=[other_day], policies=policies))
        .allow
    )


def test_site_capacity_cap_from_site_and_policy_override():
    site = make_site(daily_capacity_cap=2)
    assert SiteCapacityCap().evaluate(make_ctx(site=site, site_bookings_today=1)).allow
    assert not SiteCapacityCap().evaluate(make_ctx(site=site, site_bookings_today=2)).allow

    # an explicit policy beats the site column
    policies = PolicySet(values={"site_capacity_cap": {"max": 5}})
    assert (
        SiteCapacityCap()
        .evaluate(make_ctx(site=site, site_bookings_today=3, policies=policies))
        .allow
    )


def test_one_desk_per_day_blocks_a_second_desk_but_not_a_room():
    site = make_site()
    held = SimpleNamespace(id=uuid.uuid4(), local_date=TODAY, site_id=site.id)
    assert not OneDeskPerDay().evaluate(make_ctx(site=site, subject_bookings=[held])).allow
    assert (
        OneDeskPerDay()
        .evaluate(make_ctx(site=site, subject_bookings=[held], resource=make_resource(kind="room")))
        .allow
    )


def test_delegation_requires_permission():
    actor = SimpleNamespace(id=uuid.uuid4(), organization_id=uuid.uuid4())
    subject = SimpleNamespace(id=uuid.uuid4(), organization_id=actor.organization_id)
    ctx = make_ctx(actor=actor, subject=subject)
    assert not DelegationAllowed(False).evaluate(ctx).allow
    assert DelegationAllowed(True).evaluate(ctx).allow


# -------------------------------------------------------------------- engine


def test_every_rule_is_evaluated_so_all_reasons_arrive_together():
    """A user blocked by two rules should learn both at once, not one at a time."""
    ctx = make_ctx(
        local_date=TODAY + timedelta(days=40),
        site=make_site(daily_capacity_cap=1),
        site_bookings_today=5,
    )
    found = codes_of(evaluate(ctx))
    assert codes.HORIZON_EXCEEDED in found
    assert codes.SITE_CAPACITY_REACHED in found


def test_clean_context_produces_no_violations():
    assert evaluate(make_ctx()) == []


def test_blocking_filters_warnings():
    from app.core.errors import Violation

    vs = [
        Violation(code="a", params={}, severity="warn"),
        Violation(code="b", params={}, severity="block"),
    ]
    assert [v.code for v in blocking(vs)] == ["b"]


# ------------------------------------------------------------ policy resolution


@pytest.mark.parametrize(
    "scopes,expected",
    [
        ([("org", 0, 30)], 30),
        ([("org", 0, 30), ("site", 0, 14)], 14),  # site beats org
        ([("org", 0, 30), ("site", 0, 14), ("group", 0, 7)], 7),  # group beats site
        ([("group", 0, 7), ("group", 5, 3)], 3),  # priority breaks group ties
    ],
)
def test_policy_resolution_precedence(scopes, expected):
    policies = [
        SimpleNamespace(
            enabled=True,
            scope_type=s,
            priority=p,
            rule_type="booking_horizon",
            config={"max_days": v},
        )
        for s, p, v in scopes
    ]
    assert PolicySet.resolve(policies).get("booking_horizon", "max_days") == expected


def test_disabled_policies_are_ignored_and_defaults_apply():
    policies = [
        SimpleNamespace(
            enabled=False,
            scope_type="org",
            priority=0,
            rule_type="booking_horizon",
            config={"max_days": 1},
        )
    ]
    assert PolicySet.resolve(policies).get("booking_horizon", "max_days") == 14
