import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import anon_db
from app.core.config import get_settings
from app.core.errors import NotFound, Unauthorized
from app.core.ids import uuid7
from app.core.security import hash_token, org_from_refresh_token
from app.db.session import _apply_tenant
from app.models import IdentityProvider, Organization, OrgDomain, RefreshToken, RoleAssignment, User
from app.services.tokens import issue_pair, rotate

router = APIRouter(prefix="/auth", tags=["auth"])


class DiscoverRequest(BaseModel):
    email: EmailStr


class DiscoverResponse(BaseModel):
    organization_id: uuid.UUID
    organization_name: str
    idp_kind: str
    authorize_url: str | None = None


async def _resolve_domain(session: AsyncSession, email: str) -> OrgDomain:
    """Reads org_domains under the domain_routing policy (migration 0001), then binds
    the tenant so every subsequent query in this transaction is isolated normally."""
    domain = email.split("@")[-1].lower()
    org_domain = await session.scalar(select(OrgDomain).where(OrgDomain.domain == domain))
    if org_domain is None:
        raise NotFound("No organization is configured for this email domain")
    await _apply_tenant(session, org_domain.organization_id)
    return org_domain


@router.post("/discover", response_model=DiscoverResponse)
async def discover_tenant(
    body: DiscoverRequest, session: Annotated[AsyncSession, Depends(anon_db)]
) -> DiscoverResponse:
    """Email domain -> tenant + IdP routing (FR-1.3)."""
    org_domain = await _resolve_domain(session, body.email)
    org = await session.scalar(
        select(Organization).where(Organization.id == org_domain.organization_id)
    )
    idp = await session.scalar(select(IdentityProvider).where(IdentityProvider.enabled.is_(True)))
    s = get_settings()
    return DiscoverResponse(
        organization_id=org_domain.organization_id,
        organization_name=org.name if org else "",
        idp_kind=idp.kind if idp else "magic_link",
        authorize_url=(
            f"{s.api_base_url}/v1/auth/authorize?org={org_domain.organization_id}" if idp else None
        ),
    )


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh")
async def refresh(body: RefreshRequest, session: Annotated[AsyncSession, Depends(anon_db)]) -> dict:
    """Rotating refresh with reuse detection (TDD §12.1).

    The org id prefix on the token selects the tenant; it is not trusted for anything
    else — the token hash still has to match a live row inside that tenant.
    """
    await _apply_tenant(session, org_from_refresh_token(body.refresh_token))
    token = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(body.refresh_token))
    )
    if token is None:
        raise Unauthorized("Invalid refresh token")
    return await rotate(session, body.refresh_token)


class DevLoginRequest(BaseModel):
    email: EmailStr


@router.post("/dev-login", include_in_schema=False)
async def dev_login(
    body: DevLoginRequest, session: Annotated[AsyncSession, Depends(anon_db)]
) -> dict:
    """DEVELOPMENT ONLY — sign in as a seeded user with no IdP configured, so the
    Phase 0 exit criteria are reachable before a customer IdP exists.

    Gated twice: here, and by Settings.assert_safe() which refuses to boot outside
    development when ENABLE_DEV_LOGIN is set.
    """
    s = get_settings()
    if not (s.enable_dev_login and s.environment == "development"):
        raise NotFound("Not found")

    org_domain = await _resolve_domain(session, body.email)
    user = await session.scalar(select(User).where(User.email == body.email))
    if user is None:
        user = User(
            id=uuid7(),
            organization_id=org_domain.organization_id,
            email=body.email,
            display_name=body.email.split("@")[0].replace(".", " ").title(),
        )
        session.add(user)
        session.add(
            RoleAssignment(
                id=uuid7(),
                organization_id=org_domain.organization_id,
                user_id=user.id,
                role="employee",
            )
        )
        await session.flush()
    return await issue_pair(session, user)
