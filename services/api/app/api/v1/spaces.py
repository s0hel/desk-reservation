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
from app.models import Floor, Resource, Site, SitePhoto
from app.services import site_photos

router = APIRouter(tags=["spaces"], dependencies=[Depends(current_principal)])


class SitePhotoOut(BaseModel):
    """A photograph of the building, for the home screen header (FR-2.1).

    `aspect_ratio` is carried so the client can reserve the right box before the image
    arrives — a header that resizes when the photo lands shoves the day's booking down
    the screen just as someone is reaching for it. Same reasoning as `Plan` in the
    availability response.
    """

    url: str
    width_px: int
    height_px: int
    aspect_ratio: float


class SiteOut(BaseModel):
    id: uuid.UUID
    name: str
    #: What people call the place — "Tampa" against a `name` of "Tampa — Rocky Point".
    #: Null when the tenant has not set one; the client falls back to `name`.
    short_name: str | None
    timezone: str
    address: str | None
    checkin_enabled: bool
    photo: SitePhotoOut | None


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


async def site_out(session: AsyncSession, site: Site) -> SiteOut:
    """One site, fetching its photo. `list_sites` batches instead — both end up in
    `_site_out`, so the shape is built in exactly one place."""
    return _site_out(site, await _photo_or_none(session, site.photo_asset_id))


def _site_out(site: Site, photo: SitePhoto | None) -> SiteOut:
    return SiteOut(
        id=site.id,
        name=site.name,
        short_name=site.short_name,
        timezone=site.timezone,
        address=site.address,
        checkin_enabled=site.checkin_enabled,
        photo=_photo_out(photo),
    )


async def photo_out(session: AsyncSession, asset_id: uuid.UUID | None) -> SitePhotoOut | None:
    """One site's photo, for the admin routes, which answer about a single site."""
    return _photo_out(await _photo_or_none(session, asset_id))


async def _photo_or_none(session: AsyncSession, asset_id: uuid.UUID | None) -> SitePhoto | None:
    if asset_id is None:
        return None
    return await session.scalar(select(SitePhoto).where(SitePhoto.id == asset_id))


def _photo_out(photo: SitePhoto | None) -> SitePhotoOut | None:
    if photo is None:
        return None
    return SitePhotoOut(
        url=site_photos.photo_url(photo.id, photo.organization_id),
        width_px=photo.width_px,
        height_px=photo.height_px,
        # Guarded: a zero would be a divide-by-zero in the client's layout, and a
        # stored zero means ingest is broken, not that the header should be square.
        aspect_ratio=(photo.width_px / photo.height_px) if photo.height_px else 1.0,
    )


@router.get("/sites", response_model=list[SiteOut])
async def list_sites(session: Annotated[AsyncSession, Depends(db)]) -> list[SiteOut]:
    """Every site in the tenant. On the app-open path — the home screen resolves the
    user's home site from this list — so the photos are fetched in one query rather
    than one per site."""
    sites = list(await session.scalars(select(Site).order_by(Site.name)))
    wanted = [s.photo_asset_id for s in sites if s.photo_asset_id]
    photos = (
        {p.id: p for p in await session.scalars(select(SitePhoto).where(SitePhoto.id.in_(wanted)))}
        if wanted
        else {}
    )
    # `.get`, not `[...]`: a dangling photo_asset_id renders as no photo. The header
    # is decoration and must not take the home screen down with it.
    return [_site_out(s, photos.get(s.photo_asset_id) if s.photo_asset_id else None) for s in sites]


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
