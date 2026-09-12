"""Policy evaluation (TDD §9)."""

from collections.abc import Sequence

from app.core.errors import Violation
from app.policy.context import BookingContext
from app.policy.rules import P0_RULES, Rule


def evaluate(ctx: BookingContext, rules: Sequence[Rule] | None = None) -> list[Violation]:
    """Run every rule and return all violations, blocking ones first.

    Deliberately not short-circuiting: a user refused by both the horizon and their quota
    should learn both in one response rather than fixing one and hitting the other.
    """
    violations = [
        Violation(code=r.code or "policy.unknown", params=r.params or {}, severity=r.severity)
        for r in (rule.evaluate(ctx) for rule in (rules if rules is not None else P0_RULES))
        if not r.allow
    ]
    violations.sort(key=lambda v: 0 if v.severity == "block" else 1)
    return violations


def blocking(violations: Sequence[Violation]) -> list[Violation]:
    return [v for v in violations if v.severity == "block"]
