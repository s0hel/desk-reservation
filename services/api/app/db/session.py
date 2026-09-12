"""Database session management.

The tenant guarantee (TDD §18.2) lives here and nowhere else: every request-scoped
session issues `SET LOCAL app.org_id` inside its transaction before any query runs.
`SET LOCAL` is transaction-scoped, so a pooled connection cannot leak tenant context
to the next request — which is also why we require transaction-mode pooling.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

_settings = get_settings()

engine = create_async_engine(
    _settings.database_url,
    echo=_settings.sql_echo,
    pool_pre_ping=True,
)

SessionFactory = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def _apply_tenant(session: AsyncSession, org_id: uuid.UUID | None) -> None:
    # set_config(..., true) == SET LOCAL: reverted at transaction end.
    await session.execute(
        text("SELECT set_config('app.org_id', :org, true)"),
        {"org": str(org_id) if org_id else ""},
    )


@asynccontextmanager
async def tenant_session(org_id: uuid.UUID | None) -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        await session.begin()
        await _apply_tenant(session, org_id)
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
