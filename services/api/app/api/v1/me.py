import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, current_principal, current_user, db
from app.models import User

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


@router.get("/me", response_model=MeResponse)
async def me(
    user: Annotated[User, Depends(current_user)],
    principal: Annotated[Principal, Depends(current_principal)],
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
    )


class UpdateMe(BaseModel):
    locale: str | None = None
    presence_visibility: str | None = None
    home_site_id: uuid.UUID | None = None


@router.patch("/me", response_model=MeResponse)
async def update_me(
    body: UpdateMe,
    user: Annotated[User, Depends(current_user)],
    principal: Annotated[Principal, Depends(current_principal)],
    session: Annotated[AsyncSession, Depends(db)],
) -> MeResponse:
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await session.flush()
    return await me(user, principal)
