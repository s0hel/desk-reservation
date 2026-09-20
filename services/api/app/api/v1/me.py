import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, current_principal, current_user, db
from app.core.errors import NotFound
from app.models import Site, User
from app.services import presence as presence_service

router = APIRouter(tags=["me"])


class MeResponse(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    email: str
    display_name: str
    locale: str
    home_site_id: uuid.UUID | None
    presence_visibility: str
    roles: list[str]
    #: Server-owned feature flags. `presence` is the org-level kill switch from PRD Q6:
    #: some works councils reject colleague visibility outright, and for those tenants
    #: the app must not offer the feature at all rather than offer it and fail.
    features: dict[str, bool]


@router.get("/me", response_model=MeResponse)
async def me(
    user: Annotated[User, Depends(current_user)],
    principal: Annotated[Principal, Depends(current_principal)],
    session: Annotated[AsyncSession, Depends(db)],
) -> MeResponse:
    return MeResponse(
        id=user.id,
        organization_id=user.organization_id,
        email=user.email,
        display_name=user.display_name,
        locale=user.locale,
        home_site_id=user.home_site_id,
        presence_visibility=user.presence_visibility,
        roles=list(principal.roles),
        features={
            "presence": await presence_service.presence_enabled(session, user.organization_id),
        },
    )


class UpdateMe(BaseModel):
    locale: str | None = None
    #: FR-5.6. Validated rather than assigned: an unrecognised value here fails closed
    #: (it matches no branch of the visibility condition, so the user vanishes), which
    #: is safe but silent, and a typo should not quietly hide someone.
    presence_visibility: Literal["everyone", "team_only", "nobody"] | None = None
    #: FR-1.9. The office this person works out of: the site the home screen opens on
    #: and the one every day-picker defaults to. Null is a legitimate value — it is what
    #: sends a new joiner to the first-run picker.
    home_site_id: uuid.UUID | None = None


@router.patch("/me", response_model=MeResponse)
async def update_me(
    body: UpdateMe,
    user: Annotated[User, Depends(current_user)],
    principal: Annotated[Principal, Depends(current_principal)],
    session: Annotated[AsyncSession, Depends(db)],
) -> MeResponse:
    fields = body.model_dump(exclude_unset=True)

    # Checked explicitly, because the foreign key will not do it. Postgres runs FK
    # checks as the referencing table's owner and they are not subject to RLS, so
    # `home_site_id` set to another tenant's site id would be accepted by the
    # constraint and then read as nothing by every query that joins it — an account
    # whose home office silently does not exist. The SELECT below IS under RLS, which
    # is what makes it a real check.
    if fields.get("home_site_id") is not None:
        site = await session.scalar(select(Site).where(Site.id == fields["home_site_id"]))
        if site is None:
            raise NotFound("Site not found")

    for field, value in fields.items():
        setattr(user, field, value)
    await session.flush()
    return await me(user, principal, session)
