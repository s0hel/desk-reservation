import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Unauthorized
from app.core.ids import uuid7
from app.core.security import create_access_token, hash_token, new_refresh_token
from app.core.time import now_utc
from app.models import RefreshToken, RoleAssignment, User


async def roles_for(session: AsyncSession, user: User) -> list[str]:
    rows = await session.scalars(
        select(RoleAssignment.role).where(RoleAssignment.user_id == user.id)
    )
    roles = set(rows.all()) or {"employee"}
    return sorted(roles)


async def issue_pair(
    session: AsyncSession, user: User, *, family_id: uuid.UUID | None = None
) -> dict:
    s = get_settings()
    roles = await roles_for(session, user)
    access = create_access_token(
        user_id=user.id,
        org_id=user.organization_id,
        roles=roles,
        token_version=user.token_version,
    )
    raw, hashed = new_refresh_token(user.organization_id)
    session.add(
        RefreshToken(
            id=uuid7(),
            organization_id=user.organization_id,
            user_id=user.id,
            family_id=family_id or uuid7(),
            token_hash=hashed,
            expires_at=now_utc() + timedelta(days=s.refresh_token_ttl_days),
        )
    )
    return {
        "access_token": access,
        "refresh_token": raw,
        "token_type": "Bearer",
        "expires_in": s.access_token_ttl_seconds,
        "roles": roles,
    }


async def rotate(session: AsyncSession, raw_refresh: str) -> dict:
    """Rotation with reuse detection (TDD §12.1): replaying a spent token is treated
    as theft and revokes the entire family."""
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_refresh))
    )
    if token is None:
        raise Unauthorized("Invalid refresh token")

    now = now_utc()
    if token.revoked_at or token.used_at:
        family = await session.scalars(
            select(RefreshToken).where(RefreshToken.family_id == token.family_id)
        )
        for t in family:
            t.revoked_at = t.revoked_at or now
        raise Unauthorized("Refresh token reuse detected; session revoked")
    if token.expires_at <= now:
        raise Unauthorized("Refresh token expired")

    token.used_at = now
    user = await session.scalar(select(User).where(User.id == token.user_id))
    if user is None or user.deactivated_at is not None:
        raise Unauthorized("User not found or deactivated")
    return await issue_pair(session, user, family_id=token.family_id)
