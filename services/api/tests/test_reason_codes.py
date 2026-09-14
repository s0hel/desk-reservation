"""The reason-code mirror (TDD §9, §11).

`packages/shared/src/reason-codes.ts` and `app/policy/codes.py` are two hand-written
copies of one list, and both files carry a comment claiming CI keeps them in step.
Nothing actually checked that until this test: a code added on one side only would
reach a client as an unmapped slug, which is the exact failure the machine-readable
violation contract exists to prevent.
"""

import re
from pathlib import Path

from app.policy import codes

SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared" / "src" / "reason-codes.ts"


def _typescript_codes() -> set[str]:
    source = SHARED.read_text()
    block = source[source.index("REASON_CODES = {") : source.index("} as const;")]
    # NAME: "value",  — trailing comments after the value are allowed and ignored.
    return set(re.findall(r'^\s*[A-Z0-9_]+:\s*"([^"]+)"', block, flags=re.MULTILINE))


def test_the_two_copies_hold_the_same_codes():
    assert SHARED.exists(), f"expected the shared mirror at {SHARED}"
    python_side = set(codes.ALL)
    ts_side = _typescript_codes()

    assert ts_side, "parsed no codes out of reason-codes.ts — the parser has gone stale"
    assert python_side - ts_side == set(), "in codes.py but missing from reason-codes.ts"
    assert ts_side - python_side == set(), "in reason-codes.ts but missing from codes.py"


def test_every_code_is_namespaced():
    """`policy.` / `resource.` / `presence.` / `admin.` — a bare slug gives the client
    nothing to group on, and these strings are a public contract.

    `admin.` is the console's namespace: those refusals reach an administrator rather
    than an employee, and keeping them separate is what stops a client mapping one into
    the booking-refusal vocabulary, where it would render as advice to a person who
    cannot act on it."""
    for code in codes.ALL:
        assert "." in code, code
        assert code.split(".", 1)[0] in {"policy", "resource", "presence", "admin"}, code
