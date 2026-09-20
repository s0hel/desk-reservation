"""Blob storage for floor plan assets and site photos (TDD §14.3).

Local disk in development, S3 in staging and production. The interface is deliberately
three methods wide: these assets are written once and read many times, and nothing else
about the product needs object storage yet. Widening it speculatively would invite
callers to depend on semantics S3 and a filesystem do not share.

Keys are always `<prefix>/<org_id>/<asset_id>.<ext>`, where the prefix is one of a
closed set — org-prefixed so a misconfigured bucket policy still separates tenants, and
so a stray key cannot be traversed into another tenant's prefix. The prefix set is
closed rather than free-form for the same reason the pattern exists at all: a caller
that can choose its own prefix can choose `../`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Protocol

from app.core.config import get_settings

KEY_PREFIXES = ("plans", "photos")
KEY_PATTERN = re.compile(
    rf"^({'|'.join(KEY_PREFIXES)})/[0-9a-f-]{{36}}/[0-9a-f-]{{36}}\.[a-z0-9]{{2,5}}$"
)


class StorageError(RuntimeError):
    pass


class BlobStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...


def _validate(key: str) -> str:
    # Keys are constructed by us, never by a client — this is a tripwire for a future
    # caller that forgets that, not input validation.
    if not KEY_PATTERN.match(key):
        raise StorageError(f"Refusing malformed storage key: {key!r}")
    return key


class LocalBlobStore:
    """Filesystem-backed store rooted at `settings.storage_dir`."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        path = (self.root / _validate(key)).resolve()
        root = self.root.resolve()
        if not path.is_relative_to(root):
            raise StorageError("Storage key escapes the storage root")
        return path

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-rename: a reader never sees a half-written plan.
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise StorageError(f"Blob not found: {key}")
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()


def get_store() -> BlobStore:
    settings = get_settings()
    return LocalBlobStore(Path(settings.storage_dir))
