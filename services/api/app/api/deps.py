import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Forbidden, Unauthorized
from app.core.security import decode_access_token
from app.db.session import SessionFactory, _apply_tenant
from app.models import User


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    org_id: uuid.UUID
    roles: tuple[str, ...]
    token_version: int


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("Missing bearer token")
    return token


async def current_principal(request: Request) -> Principal:
    claims = decode_access_token(_bearer(request))
    return Principal(
        user_id=uuid.UUID(claims["sub"]),
        org_id=uuid.UUID(claims["org_id"]),
        roles=tuple(claims.get("roles", [])),
        token_version=int(claims.get("ver", 1)),
    )


async def db(
    principal: Annotated[Principal, Depends(current_principal)],
) -> AsyncIterator[AsyncSession]:
    """Tenant-bound session. There is no code path that opens one without SET LOCAL (TDD §18.2)."""
    async with SessionFactory() as session:
        await session.begin()
        await _apply_tenant(session, principal.org_id)
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def anon_db() -> AsyncIterator[AsyncSession]:
    """Unauthenticated session for tenant discovery. RLS yields nothing while
    app.org_id is unset, so callers must set it explicitly once a tenant is resolved."""
    async with SessionFactory() as session:
        await session.begin()
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def current_user(
    principal: Annotated[Principal, Depends(current_principal)],
    session: Annotated[AsyncSession, Depends(db)],
) -> User:
    user = await session.scalar(select(User).where(User.id == principal.user_id))
    if user is None or user.deactivated_at is not None:
        raise Unauthorized("User not found or deactivated")
    if user.token_version != principal.token_version:
        raise Unauthorized("Session revoked")
    return user


def require_role(*roles: str):
    async def _check(
        principal: Annotated[Principal, Depends(current_principal)],
    ) -> Principal:
        if not set(roles) & set(principal.roles):
            raise Forbidden(f"Requires one of: {', '.join(roles)}")
        return principal

    return _check
