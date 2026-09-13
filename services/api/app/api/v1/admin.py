"""Admin console endpoints — sites, floors, and the floor plan editor (TDD §14, §11).

Everything here requires an admin role. The console is a first-class API consumer with
no database access of its own, which is what keeps the API honest: any capability the
console has, an integration could have too.

The editor's contract is deliberately coarse. It reads a whole floor in one call and
writes a whole layout in one call, because the thing being edited is a document and the
save is explicit and batched (TDD §14.3). Per-desk endpoints would invite a chatty
editor that saves on every drag and has no undo.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, db, require_role
from app.core.config import get_settings
from app.core.errors import NotFound
from app.core.ids import uuid7
from app.core.security import sign_asset_url
from app.models import Floor, FloorPlanAsset, Group, Resource, Site, User
from app.services import layout as layout_service
from app.services import plan_assets
from app.services.storage import get_store

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_role("site_admin", "org_admin"))],
)


# ------------------------------------------------------------------------ schemas


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    timezone: str = Field(min_length=1, max_length=64)
    address: str | None = None
    opening_hours: dict = Field(default_factory=dict)


class SiteOut(BaseModel):
    id: uuid.UUID
    name: str
    timezone: str
    address: str | None


class FloorIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    ordinal: int = 0


class PlanOut(BaseModel):
    asset_id: uuid.UUID
    url: str
    width_px: int
    height_px: int
    content_type: str
    #: True when the stored image is not the uploaded bytes (a rasterized PDF, or an
    #: oversized scan that was downscaled). The console says so rather than leaving the
    #: admin wondering why their 300MB TIFF looks different.
    converted: bool = False


class FloorSummaryOut(BaseModel):
    id: uuid.UUID
    site_id: uuid.UUID
    name: str
    ordinal: int
    plan_width_px: int | None
    plan_height_px: int | None
    published_at: datetime | None
    resource_count: int
    has_draft: bool


class GroupOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str


class FloorEditorOut(BaseModel):
    """Everything the editor needs to open a floor, in one round trip."""

    floor: FloorSummaryOut
    site: SiteOut
    plan: PlanOut | None
    layout: layout_service.FloorLayout
    is_draft: bool
    draft_updated_at: datetime | None
    groups: list[GroupOut]


class LayoutSavedOut(BaseModel):
    base_version: int
    updated_at: datetime
    layout: layout_service.FloorLayout


class PublishIn(BaseModel):
    #: Set after the admin has been shown the affected-booking count and accepted it.
    accept_orphans: bool = False


# ------------------------------------------------------------------------- helpers


async def _floor_or_404(session: AsyncSession, floor_id: uuid.UUID) -> Floor:
    floor = await session.scalar(select(Floor).where(Floor.id == floor_id))
    if floor is None:
        raise NotFound("Floor not found")
    return floor


async def _plan_out(session: AsyncSession, asset_id: uuid.UUID | None) -> PlanOut | None:
    if asset_id is None:
        return None
    asset = await session.scalar(select(FloorPlanAsset).where(FloorPlanAsset.id == asset_id))
    if asset is None:
        return None
    return PlanOut(
        asset_id=asset.id,
        url=plan_url(asset.id, asset.organization_id),
        width_px=asset.width_px,
        height_px=asset.height_px,
        content_type=asset.content_type,
    )


def plan_url(asset_id: uuid.UUID, org_id: uuid.UUID) -> str:
    base = get_settings().api_base_url.rstrip("/")
    return f"{base}/v1/plans/{asset_id}?t={sign_asset_url(asset_id, org_id)}"


async def _floor_summary(session: AsyncSession, floor: Floor) -> FloorSummaryOut:
    resource_count = await session.scalar(
        select(func.count())
        .select_from(Resource)
        .where(Resource.floor_id == floor.id)
        .where(Resource.status == "active")
    )
    draft = await layout_service.get_draft(session, floor)
    return FloorSummaryOut(
        id=floor.id,
        site_id=floor.site_id,
        name=floor.name,
        ordinal=floor.ordinal,
        plan_width_px=floor.plan_width_px,
        plan_height_px=floor.plan_height_px,
        published_at=floor.published_at,
        resource_count=resource_count or 0,
        has_draft=draft is not None,
    )


# ----------------------------------------------------------------- sites and floors


@router.post("/sites", response_model=SiteOut, status_code=201)
async def create_site(
    body: SiteIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> Site:
    """FR-8.1. The timezone is the site's, and it is the authority for "a day" (TDD §5)."""
    site = Site(
        id=uuid7(),
        organization_id=actor.organization_id,
        name=body.name,
        timezone=body.timezone,
        address=body.address,
        opening_hours=body.opening_hours,
    )
    session.add(site)
    await session.flush()
    return site


@router.post("/sites/{site_id}/floors", response_model=FloorSummaryOut, status_code=201)
async def create_floor(
    site_id: uuid.UUID,
    body: FloorIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> FloorSummaryOut:
    site = await session.scalar(select(Site).where(Site.id == site_id))
    if site is None:
        raise NotFound("Site not found")
    floor = Floor(
        id=uuid7(),
        organization_id=actor.organization_id,
        site_id=site.id,
        name=body.name,
        ordinal=body.ordinal,
    )
    session.add(floor)
    await session.flush()
    return await _floor_summary(session, floor)


@router.get("/sites/{site_id}/floors", response_model=list[FloorSummaryOut])
async def list_floors(
    site_id: uuid.UUID, session: Annotated[AsyncSession, Depends(db)]
) -> list[FloorSummaryOut]:
    floors = await session.scalars(
        select(Floor).where(Floor.site_id == site_id).order_by(Floor.ordinal)
    )
    return [await _floor_summary(session, f) for f in floors]


@router.get("/groups", response_model=list[GroupOut])
async def list_groups(session: Annotated[AsyncSession, Depends(db)]) -> list[Group]:
    """Zone permissions are granted to groups (FR-6.4), so the editor needs the list."""
    return list(await session.scalars(select(Group).order_by(Group.name)))


# ------------------------------------------------------------------------- editor


@router.get("/floors/{floor_id}", response_model=FloorEditorOut)
async def open_floor(
    floor_id: uuid.UUID, session: Annotated[AsyncSession, Depends(db)]
) -> FloorEditorOut:
    floor = await _floor_or_404(session, floor_id)
    site = await session.scalar(select(Site).where(Site.id == floor.site_id))
    layout, is_draft = await layout_service.current_layout(session, floor)
    draft = await layout_service.get_draft(session, floor)
    # The editor shows the plan the LAYOUT points at, not the one the floor is published
    # with — otherwise uploading a replacement would leave the admin editing desks over
    # the old image.
    return FloorEditorOut(
        floor=await _floor_summary(session, floor),
        site=SiteOut(id=site.id, name=site.name, timezone=site.timezone, address=site.address),
        plan=await _plan_out(session, layout.plan_asset_id),
        layout=layout,
        is_draft=is_draft,
        draft_updated_at=draft.updated_at if draft else None,
        groups=list(await session.scalars(select(Group).order_by(Group.name))),
    )


@router.put("/floors/{floor_id}/layout", response_model=LayoutSavedOut)
async def save_layout(
    floor_id: uuid.UUID,
    body: layout_service.FloorLayout,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> LayoutSavedOut:
    """Explicit, batched save (TDD §14.3). Writes a draft; employees see nothing yet."""
    floor = await _floor_or_404(session, floor_id)
    draft = await layout_service.save_draft(session, floor, body, actor)
    return LayoutSavedOut(
        base_version=draft.base_version,
        updated_at=draft.updated_at,
        layout=layout_service.FloorLayout.model_validate(draft.layout),
    )


@router.delete("/floors/{floor_id}/draft", status_code=204)
async def discard_draft(floor_id: uuid.UUID, session: Annotated[AsyncSession, Depends(db)]) -> None:
    floor = await _floor_or_404(session, floor_id)
    await layout_service.discard_draft(session, floor)


@router.post("/floors/{floor_id}/plan", response_model=PlanOut, status_code=201)
async def upload_plan(
    floor_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
    file: Annotated[UploadFile, File()],
) -> PlanOut:
    """Upload an image or PDF; the server rasterizes and returns dimensions (TDD §14.3).

    The asset is attached to the DRAFT, not to the live floor. Replacing a plan is an
    edit like any other and must not become visible to employees before publish — and
    the aspect-ratio warning (TDD §14.2) has to be reviewable before it takes effect.
    """
    settings = get_settings()
    floor = await _floor_or_404(session, floor_id)

    # Read with a hard ceiling rather than trusting Content-Length.
    body = await file.read(settings.max_plan_upload_bytes + 1)
    rendered = plan_assets.ingest(body, file.content_type or "", file.filename)

    asset = FloorPlanAsset(
        id=uuid7(),
        organization_id=actor.organization_id,
        original_key="",
        rendered_key="",
        width_px=rendered.width_px,
        height_px=rendered.height_px,
        content_type=rendered.content_type,
        checksum=rendered.checksum,
    )
    key = plan_assets.storage_key(actor.organization_id, asset.id, rendered.extension)
    asset.original_key = key
    asset.rendered_key = key
    session.add(asset)

    # Write the blob before the transaction commits: an orphaned blob is harmless, a row
    # pointing at a blob that was never written is a broken floor.
    get_store().put(key, rendered.data)
    await session.flush()

    layout, _ = await layout_service.current_layout(session, floor)
    layout.plan_asset_id = asset.id
    await layout_service.save_draft(session, floor, layout, actor)

    return PlanOut(
        asset_id=asset.id,
        url=plan_url(asset.id, asset.organization_id),
        width_px=asset.width_px,
        height_px=asset.height_px,
        content_type=asset.content_type,
        converted=rendered.converted,
    )


@router.get("/floors/{floor_id}/publish")
async def preflight(floor_id: uuid.UUID, session: Annotated[AsyncSession, Depends(db)]) -> dict:
    """What publishing would do, including the bookings it would strand (TDD §14.3)."""
    floor = await _floor_or_404(session, floor_id)
    layout, _ = await layout_service.current_layout(session, floor)
    plan = await layout_service.build_plan(session, floor, layout)
    return layout_service.plan_summary(plan, floor.published_at)


@router.post("/floors/{floor_id}/publish")
async def publish(
    floor_id: uuid.UUID,
    body: PublishIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> dict:
    floor = await _floor_or_404(session, floor_id)
    layout, _ = await layout_service.current_layout(session, floor)
    plan = await layout_service.publish(
        session, floor, layout, actor, accept_orphans=body.accept_orphans
    )
    return layout_service.plan_summary(plan, floor.published_at)


@router.get("/floors/{floor_id}/codes", response_model=list[str])
async def taken_codes(
    floor_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    prefix: Annotated[str | None, Query(max_length=50)] = None,
) -> list[str]:
    """Codes already used elsewhere on this site.

    Bulk creation generates names from a pattern (`4F-A-{01..24}`), and the constraint
    it can violate is site-wide, not floor-wide. Handing the editor the taken codes lets
    it show the clash while the admin is still typing the pattern, instead of failing
    the whole batch on save.
    """
    floor = await _floor_or_404(session, floor_id)
    stmt = (
        select(Resource.code)
        .where(Resource.site_id == floor.site_id)
        .where(Resource.floor_id != floor.id)
        .where(Resource.status == "active")
    )
    if prefix:
        stmt = stmt.where(Resource.code.startswith(prefix))
    return sorted(await session.scalars(stmt))
