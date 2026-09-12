import os
import subprocess
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("ENABLE_DEV_LOGIN", "true")

from app.db.session import SessionFactory, _apply_tenant  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def migrate() -> None:
    subprocess.run(["alembic", "upgrade", "head"], check=True, cwd=os.getcwd())


@pytest.fixture
async def org_a() -> uuid.UUID:
    return await _make_org("tenant-a")


@pytest.fixture
async def org_b() -> uuid.UUID:
    return await _make_org("tenant-b")


async def _make_org(slug: str) -> uuid.UUID:
    org_id = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, org_id)
        await s.execute(
            text("INSERT INTO organizations (id, name, slug) VALUES (:i, :n, :s)"),
            {"i": org_id, "n": slug, "s": f"{slug}-{org_id.hex[:8]}"},
        )
        await s.commit()
    return org_id


@pytest.fixture
async def session_for():
    """Yields a factory producing a tenant-bound session, so tests can act as either org."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _factory(org_id: uuid.UUID) -> AsyncIterator:
        async with SessionFactory() as s:
            await s.begin()
            await _apply_tenant(s, org_id)
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    yield _factory
