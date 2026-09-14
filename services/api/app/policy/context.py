"""Inputs to policy evaluation (TDD §9).

The context is immutable and fully pre-loaded: rules are pure functions that perform no
I/O, which is what makes the policy matrix exhaustively testable. Every query a rule could
need is resolved before evaluation begins.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from app.models import Blackout, Booking, Resource, Site, User, ZonePermission

#: Fallback configuration when a tenant has no policy row for a rule. Kept here rather
#: than in the database so a fresh organization behaves sensibly with zero setup.
DEFAULTS: dict[str, dict[str, Any]] = {
    "booking_horizon": {"max_days": 14},
    "max_concurrent_bookings": {"max": 10},
    "one_desk_per_day": {"enabled": True},
}

_SCOPE_SPECIFICITY = {"org": 1, "site": 2, "group": 3}


@dataclass(frozen=True)
class PolicySet:
    """Resolved configuration, most specific scope winning per rule type."""

    values: dict[str, dict[str, Any]] = field(default_factory=dict)

    def config(self, rule_type: str) -> dict[str, Any]:
        return {**DEFAULTS.get(rule_type, {}), **self.values.get(rule_type, {})}

    def get(self, rule_type: str, key: str, default: Any = None) -> Any:
        return self.config(rule_type).get(key, default)

    @classmethod
    def resolve(cls, policies) -> "PolicySet":
        """group > site > org, ties broken by explicit priority then by scope id.

        Deterministic by construction: two evaluations of the same inputs always pick the
        same policy row, which matters because a user who is refused twice must be given
        the same reason both times.
        """
        chosen: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        for p in policies:
            if not p.enabled:
                continue
            rank = (_SCOPE_SPECIFICITY.get(p.scope_type, 0), p.priority)
            current = chosen.get(p.rule_type)
            if current is None or rank > current[0]:
                chosen[p.rule_type] = (rank, p.config or {})
        return cls(values={k: v for k, (_, v) in chosen.items()})


@dataclass(frozen=True)
class BookingContext:
    organization_id: uuid.UUID
    actor: User
    subject: User
    site: Site
    resource: Resource | None
    starts_at: datetime
    ends_at: datetime
    local_date: date
    #: The subject's active bookings in the relevant window, pre-loaded.
    subject_bookings: tuple[Booking, ...]
    #: Active bookings at this site on this local date, for the capacity cap.
    site_bookings_today: int
    policies: PolicySet
    now: datetime
    #: Groups the SUBJECT belongs to. The subject, not the actor: a team lead booking on
    #: behalf of someone else must be judged by that person's access, not their own.
    subject_group_ids: frozenset[uuid.UUID] = frozenset()
    #: Permissions on the resource's zone. Empty means an open zone (FR-6.4).
    zone_permissions: tuple[ZonePermission, ...] = ()
    #: Blackouts overlapping this date for this site, floor, or the whole org (FR-6.5).
    blackouts: tuple[Blackout, ...] = ()

    @property
    def is_delegated(self) -> bool:
        return self.actor.id != self.subject.id
