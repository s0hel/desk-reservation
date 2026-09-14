"""Policy rules (TDD §9).

Each rule is a pure function of the context. No I/O, no ordering dependencies, and every
rule is evaluated even after one has already refused — so a user blocked by two rules
learns both reasons in one round trip rather than discovering them one at a time.

Rules never produce user-facing prose. They return a code plus params; the client renders
the localized message (FR-6.9 + FR-10.4).
"""

from typing import Any, Literal, NamedTuple, Protocol

from app.core.time import materialize_opening_hours
from app.policy import codes
from app.policy.context import BookingContext
from app.services.restrictions import blackout_violation, zone_violation

Severity = Literal["block", "warn"]


class RuleResult(NamedTuple):
    allow: bool
    code: str | None = None
    params: dict[str, Any] | None = None
    severity: Severity = "block"


ALLOW = RuleResult(allow=True)


def deny(code: str, severity: Severity = "block", **params: Any) -> RuleResult:
    return RuleResult(allow=False, code=code, params=params, severity=severity)


class Rule(Protocol):
    id: str

    def evaluate(self, ctx: BookingContext) -> RuleResult: ...


class ResourceBookable:
    """A desk taken out of service is refused with the admin's reason, not a generic error."""

    id = "resource_bookable"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        r = ctx.resource
        if r is None:
            return ALLOW
        if not r.bookable or r.status != "active":
            return deny(
                codes.RESOURCE_OUT_OF_SERVICE,
                code_ref=r.code,
                reason=r.out_of_service_reason or "",
            )
        return ALLOW


class OpeningHours:
    """FR-2.2. Hours are wall-clock per weekday, materialized per date so DST is handled
    by the materialization rather than by offset arithmetic (TDD §5)."""

    id = "opening_hours"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        window = materialize_opening_hours(
            ctx.site.opening_hours or {}, ctx.site.timezone, ctx.local_date
        )
        if window is None:
            return deny(codes.OUTSIDE_OPENING_HOURS, date=ctx.local_date.isoformat(), closed=True)
        opens, closes = window
        if ctx.starts_at < opens or ctx.ends_at > closes:
            return deny(
                codes.OUTSIDE_OPENING_HOURS,
                date=ctx.local_date.isoformat(),
                closed=False,
            )
        return ALLOW


class BookingHorizon:
    """FR-6.1."""

    id = "booking_horizon"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        max_days = int(ctx.policies.get("booking_horizon", "max_days", 14))
        today = ctx.now.astimezone(ctx.starts_at.tzinfo).date()
        ahead = (ctx.local_date - today).days
        if ahead > max_days:
            return deny(codes.HORIZON_EXCEEDED, max_days=max_days, requested_days=ahead)
        return ALLOW


class MaxConcurrentBookings:
    """FR-6.2. Counts the subject's future active bookings, excluding this date so that
    changing an existing day is never blocked by the booking it is replacing."""

    id = "max_concurrent_bookings"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        limit = int(ctx.policies.get("max_concurrent_bookings", "max", 10))
        held = sum(
            1
            for b in ctx.subject_bookings
            if b.local_date >= ctx.now.date() and b.local_date != ctx.local_date
        )
        if held >= limit:
            return deny(codes.MAX_CONCURRENT_REACHED, max=limit, held=held)
        return ALLOW


class SiteCapacityCap:
    """FR-6.3. A hard ceiling on bookings per day, deliberately allowed to sit below the
    physical desk count — the point is to cap attendance, not to fill the floor."""

    id = "site_capacity_cap"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        cap = ctx.policies.get("site_capacity_cap", "max", None)
        if cap is None:
            cap = ctx.site.daily_capacity_cap
        if cap is None:
            return ALLOW
        if ctx.site_bookings_today >= int(cap):
            return deny(
                codes.SITE_CAPACITY_REACHED, capacity=int(cap), date=ctx.local_date.isoformat()
            )
        return ALLOW


class OneDeskPerDay:
    """A person holds at most one desk per site per local date. Rooms are exempt: booking
    a meeting room is not the same act as claiming a seat for the day."""

    id = "one_desk_per_day"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        if not ctx.policies.get("one_desk_per_day", "enabled", True):
            return ALLOW
        if ctx.resource is not None and ctx.resource.kind != "desk":
            return ALLOW
        clash = next(
            (
                b
                for b in ctx.subject_bookings
                if b.local_date == ctx.local_date and b.site_id == ctx.site.id
            ),
            None,
        )
        if clash is not None:
            return deny(
                codes.ALREADY_BOOKED_TODAY,
                date=ctx.local_date.isoformat(),
                booking_id=str(clash.id),
            )
        return ALLOW


class DelegationAllowed:
    """FR-2.10. Booking for someone else requires being their group lead or an admin.
    Scope is resolved server-side from the actor's roles, never from the request."""

    id = "delegation_allowed"

    def __init__(self, actor_may_delegate: bool) -> None:
        self.actor_may_delegate = actor_may_delegate

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        if ctx.is_delegated and not self.actor_may_delegate:
            return deny(codes.DELEGATION_NOT_PERMITTED)
        return ALLOW


#: The six P0 rules for Phase 1 (PRD FR-6.1–6.3, 6.9 plus opening hours and resource state).
#: DelegationAllowed is constructed per-request because it depends on the actor's roles.
class ZoneAccess:
    """FR-6.4. A zone may be held for named groups, or released to everyone after a
    wall-clock cut-off.

    The decision itself lives in `services/restrictions.py` because the availability
    query has to reach the same answer. Two implementations of "may this person book
    here" is how a desk comes to render green and then refuse.
    """

    id = "zone_access"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        if ctx.resource is None or ctx.resource.zone_id is None:
            return ALLOW
        violation = zone_violation(
            ctx.zone_permissions,
            member_of=ctx.subject_group_ids,
            site_timezone=ctx.site.timezone,
            local_date=ctx.local_date,
            now=ctx.now,
        )
        if violation is None:
            return ALLOW
        return RuleResult(
            allow=False, code=violation.code, params=violation.params, severity="block"
        )


class BlackoutWindow:
    """FR-6.5. Holidays and maintenance close a site, a floor, or the whole org."""

    id = "blackout"

    def evaluate(self, ctx: BookingContext) -> RuleResult:
        violation = blackout_violation(
            ctx.blackouts,
            local_date=ctx.local_date,
            floor_id=ctx.resource.floor_id if ctx.resource else None,
        )
        if violation is None:
            return ALLOW
        return RuleResult(
            allow=False, code=violation.code, params=violation.params, severity="block"
        )


P0_RULES: tuple[Rule, ...] = (
    ResourceBookable(),
    OpeningHours(),
    BlackoutWindow(),
    ZoneAccess(),
    BookingHorizon(),
    MaxConcurrentBookings(),
    SiteCapacityCap(),
    OneDeskPerDay(),
)
