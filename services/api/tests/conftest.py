"""Test fixtures.

The suite runs against its own database, never the development one. Tests create
organizations, users and resources on every run; pointing them at `deskflow` left
dozens of junk tenants behind and would eventually make seeded utilization figures
meaningless. The test database is dropped and recreated at the start of each session,
so every run starts empty and the migration is exercised every time.

A separate database rather than a separate schema: extensions, role grants and
database-level privileges are all per-database, so this keeps the test environment a
faithful copy of production rather than a variant of it.
"""

import os
import subprocess
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from sqlalchemy import text

from app.core.config import Settings, get_settings

API_DIR = Path(__file__).resolve().parent.parent

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("ENABLE_DEV_LOGIN", "true")


def _with_database(url: str, name: str) -> str:
    parts = urlsplit(url)
    return urlunsplit(parts._replace(path=f"/{name}"))


def _database_name(url: str) -> str:
    return urlsplit(url).path.lstrip("/")


def _test_name(url: str) -> str:
    return f"{_database_name(url)}_test"


# Resolve the configured (development) URLs first, derive the test URLs from them,
# then put those in the environment BEFORE app.db.session is imported — the engine is
# created at import time from these settings.
_configured = Settings()
_test_db_url = os.environ.get("TEST_DATABASE_URL") or _with_database(
    _configured.database_url, _test_name(_configured.database_url)
)
_test_migration_url = os.environ.get("TEST_MIGRATION_DATABASE_URL") or _with_database(
    _configured.migration_database_url, _test_name(_configured.migration_database_url)
)

if _database_name(_test_db_url) == _database_name(_configured.database_url):
    raise RuntimeError(
        f"the test database must not be the development database "
        f"({_database_name(_test_db_url)}); the suite drops it on every run"
    )

os.environ["DATABASE_URL"] = _test_db_url
os.environ["MIGRATION_DATABASE_URL"] = _test_migration_url
get_settings.cache_clear()

from app.db.session import SessionFactory, _apply_tenant, engine  # noqa: E402

TEST_DB_NAME = _database_name(_test_db_url)
APP_ROLE = urlsplit(_test_db_url).username


def _admin_connection() -> psycopg.Connection:
    """Owner connection to the maintenance database, for CREATE/DROP DATABASE."""
    dsn = _with_database(_test_migration_url, "postgres").replace("+psycopg", "")
    return psycopg.connect(dsn, autocommit=True)


def _recreate_test_database() -> None:
    with _admin_connection() as conn:
        # FORCE terminates any connection left over from an interrupted run.
        conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB_NAME}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')

    # The API role must be able to reach the new database. Table grants come from the
    # migration itself; these are the database- and schema-level ones that precede it.
    owner_dsn = _test_migration_url.replace("+psycopg", "")
    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_ROLE,)).fetchone()
        if exists:
            conn.execute(f'GRANT CONNECT ON DATABASE "{TEST_DB_NAME}" TO {APP_ROLE}')
            conn.execute(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}")


@pytest.fixture(scope="session", autouse=True)
def database() -> None:
    _recreate_test_database()
    subprocess.run(["alembic", "upgrade", "head"], check=True, cwd=API_DIR)


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


@pytest.fixture(scope="session", autouse=True)
async def _dispose_engine():
    yield
    await engine.dispose()
