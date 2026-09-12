"""Read-only space endpoints. Phase 0 exit criteria: a real phone signs in and lists
seeded resources (TDD §21)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_principal, db
from app.core.errors import NotFound
from app.models import Floor, Resource, Site

router = APIRouter(tags=["spaces"], dependencies=[Depends(current_principal)])


class SiteOut(BaseModel):
    id: uuid.UUID
    name: str
    timezone: str
    address: str | None
    checkin_enabled: bool


class FloorOut(BaseModel):
    id: uuid.UUID
    site_id: uuid.UUID
    name: str
    ordinal: int
    plan_width_px: int | None
    plan_height_px: int | None


class ResourceOut(BaseModel):
    id: uuid.UUID
    floor_id: uuid.UUID
    zone_id: uuid.UUID | None
    kind: str
    code: str
    name: str | None
    capacity: int
    position: dict
    attributes: dict
    bookable: bool
    site_timezone: str  # always returned so the client never guesses (TDD §5)


@router.get("/sites", response_model=list[SiteOut])
async def list_sites(session: Annotated[AsyncSession, Depends(db)]) -> list[Site]:
    return list(await session.scalars(select(Site).order_by(Site.name)))


@router.get("/sites/{site_id}/floors", response_model=list[FloorOut])
async def list_floors(
    site_id: uuid.UUID, session: Annotated[AsyncSession, Depends(db)]
) -> list[Floor]:
    return list(
        await session.scalars(select(Floor).where(Floor.site_id == site_id).order_by(Floor.ordinal))
    )


@router.get("/floors/{floor_id}/resources", response_model=list[ResourceOut])
async def list_resources(
    floor_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    kind: str | None = None,
) -> list[ResourceOut]:
    floor = await session.scalar(select(Floor).where(Floor.id == floor_id))
    if floor is None:
        raise NotFound("Floor not found")
    site = await session.scalar(select(Site).where(Site.id == floor.site_id))
    stmt = select(Resource).where(Resource.floor_id == floor_id)
    if kind:
        stmt = stmt.where(Resource.kind == kind)
    rows = await session.scalars(stmt.order_by(Resource.code))
    return [
        ResourceOut(
            id=r.id,
            floor_id=r.floor_id,
            zone_id=r.zone_id,
            kind=r.kind,
            code=r.code,
            name=r.name,
            capacity=r.capacity,
            position=r.position,
            attributes=r.attributes,
            bookable=r.bookable,
            site_timezone=site.timezone if site else "UTC",
        )
        for r in rows
    ]
