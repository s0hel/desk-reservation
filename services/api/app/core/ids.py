"""UUIDv7 primary keys (TDD §6): time-ordered, so index locality stays good as tables grow."""

import os
import time
import uuid

try:  # Python 3.14+
    from uuid import uuid7 as _uuid7  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - fallback for 3.12/3.13

    def _uuid7() -> uuid.UUID:
        ms = int(time.time() * 1000)
        rand = os.urandom(10)
        b = bytearray(ms.to_bytes(6, "big") + rand)
        b[6] = (b[6] & 0x0F) | 0x70  # version 7
        b[8] = (b[8] & 0x3F) | 0x80  # RFC 4122 variant
        return uuid.UUID(bytes=bytes(b))


def uuid7() -> uuid.UUID:
    return _uuid7()
