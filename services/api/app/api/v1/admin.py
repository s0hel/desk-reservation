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
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, db, require_role
from app.api.v1.spaces import SitePhotoOut, photo_out
from app.core.config import get_settings
from app.core.errors import NotFound
from app.core.ids import uuid7
from app.core.security import sign_asset_url
from app.models import (
    Blackout,
    Booking,
    Floor,
    FloorPlanAsset,
    Group,
    Resource,
    Site,
    SitePhoto,
    User,
)
from app.models.booking import ACTIVE_STATUSES
from app.services import layout as layout_service
from app.services import plan_assets, site_photos
from app.services.booking import cancel_booking
from app.services.storage import get_store

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_role("site_admin", "org_admin"))],
)


# ------------------------------------------------------------------------ schemas


class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    #: The place, for the greeting on the home screen — "Tampa", where `name` is
    #: "Tampa — Rocky Point" (FR-2.1). Optional; the client falls back to `name`.
    short_name: str | None = Field(default=None, max_length=100)
    timezone: str = Field(min_length=1, max_length=64)
    address: str | None = None
    opening_hours: dict = Field(default_factory=dict)


class SitePatch(BaseModel):
    """Every field optional, and `exclude_unset` is what makes that mean anything:
    clearing `short_name` is sending null, and not touching it is omitting it."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    short_name: str | None = Field(default=None, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    address: str | None = None
    opening_hours: dict | None = None


class SiteOut(BaseModel):
    id: uuid.UUID
    name: str
    short_name: str | None
    timezone: str
    address: str | None
    photo: SitePhotoOut | None


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
    # from_attributes because this one is built from ORM rows by hand, inside
    # FloorEditorOut, rather than only ever being returned as a response_model (which
    # is where FastAPI would do the conversion for us).
    model_config = ConfigDict(from_attributes=True)

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


async def _site_out(session: AsyncSession, site: Site) -> SiteOut:
    return SiteOut(
        id=site.id,
        name=site.name,
        short_name=site.short_name,
        timezone=site.timezone,
        address=site.address,
        photo=await photo_out(session, site.photo_asset_id),
    )


async def _site_or_404(session: AsyncSession, site_id: uuid.UUID) -> Site:
    site = await session.scalar(select(Site).where(Site.id == site_id))
    if site is None:
        raise NotFound("Site not found")
    return site


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
) -> SiteOut:
    """FR-8.1. The timezone is the site's, and it is the authority for "a day" (TDD §5)."""
    site = Site(
        id=uuid7(),
        organization_id=actor.organization_id,
        name=body.name,
        short_name=body.short_name,
        timezone=body.timezone,
        address=body.address,
        opening_hours=body.opening_hours,
    )
    session.add(site)
    await session.flush()
    return await _site_out(session, site)


@router.patch("/sites/{site_id}", response_model=SiteOut)
async def update_site(
    site_id: uuid.UUID,
    body: SitePatch,
    session: Annotated[AsyncSession, Depends(db)],
) -> SiteOut:
    """Edit a site's details (FR-8.1).

    Changing `timezone` moves every future day boundary at this site (TDD §5), which is
    why it is here rather than nowhere: a site created in the wrong zone currently has
    no way back short of SQL. It does not rewrite existing bookings — those are stored
    as UTC instants and stay at the same moment in time, which is the correct answer
    for a site that was mis-filed and the wrong one for a site that has moved. That
    second case is a migration, not a field edit.
    """
    site = await _site_or_404(session, site_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(site, field, value)
    await session.flush()
    return await _site_out(session, site)


@router.post("/sites/{site_id}/photo", response_model=SiteOut, status_code=201)
async def upload_site_photo(
    site_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
    file: Annotated[UploadFile, File()],
) -> SiteOut:
    """A picture of the building, shown at the top of the home screen (FR-2.1).

    Unlike a floor plan, this is live the moment it is uploaded: there is no draft and
    no publish step, because a photo has no relationship to desk positions and nothing
    can be stranded by replacing it. The whole site is returned rather than just the
    photo so the console re-renders from one answer.
    """
    settings = get_settings()
    site = await _site_or_404(session, site_id)

    # Read with a hard ceiling rather than trusting Content-Length.
    body = await file.read(settings.max_site_photo_upload_bytes + 1)
    rendered = site_photos.ingest(body, file.content_type or "")

    photo = SitePhoto(
        id=uuid7(),
        organization_id=actor.organization_id,
        storage_key="",
        width_px=rendered.width_px,
        height_px=rendered.height_px,
        content_type=rendered.content_type,
        checksum=rendered.checksum,
    )
    photo.storage_key = site_photos.storage_key(actor.organization_id, photo.id, rendered.extension)
    session.add(photo)

    # Write the blob before the transaction commits: an orphaned blob is harmless, a
    # row pointing at a blob that was never written is a broken header image.
    get_store().put(photo.storage_key, rendered.data)
    await session.flush()

    # The previous photo's row and blob are deliberately left behind. Deleting them
    # here would race every phone that is part-way through fetching the old URL, and a
    # few kilobytes is a cheaper problem than a header that 404s mid-download.
    site.photo_asset_id = photo.id
    await session.flush()
    return await _site_out(session, site)


@router.delete("/sites/{site_id}/photo", response_model=SiteOut)
async def delete_site_photo(
    site_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> SiteOut:
    """Remove the header photo.

    The app falls back to the site's initials over a tinted band, which occupies the
    same box — so the home screen loses a photograph, not its layout.
    """
    site = await _site_or_404(session, site_id)
    site.photo_asset_id = None
    await session.flush()
    return await _site_out(session, site)


@router.post("/sites/{site_id}/floors", response_model=FloorSummaryOut, status_code=201)
async def create_floor(
    site_id: uuid.UUID,
    body: FloorIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> FloorSummaryOut:
    site = await _site_or_404(session, site_id)
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


# `GET /admin/groups` lives in admin_people.py — it is directory administration, and the
# editor does not need it: a floor's own response already embeds the groups its zone
# permissions can be granted to.


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
        site=await _site_out(session, site),
        plan=await _plan_out(session, layout.plan_asset_id),
        layout=layout,
        is_draft=is_draft,
        draft_updated_at=draft.updated_at if draft else None,
        groups=[
            GroupOut.model_validate(group)
            for group in await session.scalars(select(Group).order_by(Group.name))
        ],
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


class BlackoutIn(BaseModel):
    """A holiday or a closure (FR-6.5).

    Scope narrows: no site means the whole organization, a site with no floor means the
    whole site, and both means one floor.
    """

    site_id: uuid.UUID | None = None
    floor_id: uuid.UUID | None = None
    starts_on: date
    ends_on: date
    reason: str | None = Field(default=None, max_length=500)
    #: Whether to cancel the bookings this closure invalidates. Off by default: an admin
    #: pencilling in next year's holidays should not silently cancel anything, and the
    #: preview below exists so the decision is made with the number in view.
    cancels_bookings: bool = False

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> BlackoutIn:
        # A field rule, so it rides the existing RequestValidationError handler and
        # arrives as the same problem+json shape as any other 422. Inventing a policy
        # reason code for it would put an admin-only validation error into the mirrored
        # set the mobile client renders from.
        if self.ends_on < self.starts_on:
            raise ValueError("ends_on must not be before starts_on")
        return self


class BlackoutOut(BaseModel):
    id: uuid.UUID
    site_id: uuid.UUID | None
    floor_id: uuid.UUID | None
    starts_on: date
    ends_on: date
    reason: str | None
    cancels_bookings: bool
    #: Active bookings the closure covers. Present on the preview and on the created
    #: row, so "3 bookings cancelled" can be reported rather than merely done.
    affected_bookings: int = 0


def _blackout_out(row: Blackout, affected: int = 0) -> BlackoutOut:
    return BlackoutOut(
        id=row.id,
        site_id=row.site_id,
        floor_id=row.floor_id,
        starts_on=row.starts_on,
        ends_on=row.ends_on,
        reason=row.reason,
        cancels_bookings=row.cancels_bookings,
        affected_bookings=affected,
    )


def _covered_bookings(body: BlackoutIn):
    """Active bookings a closure would invalidate."""
    stmt = (
        select(Booking)
        .join(Resource, Resource.id == Booking.resource_id)
        .where(
            Booking.local_date >= body.starts_on,
            Booking.local_date <= body.ends_on,
            Booking.status.in_(ACTIVE_STATUSES),
        )
    )
    if body.floor_id is not None:
        stmt = stmt.where(Resource.floor_id == body.floor_id)
    elif body.site_id is not None:
        stmt = stmt.where(Resource.site_id == body.site_id)
    return stmt


@router.get("/blackouts", response_model=list[BlackoutOut])
async def list_blackouts(
    session: Annotated[AsyncSession, Depends(db)],
    site_id: Annotated[uuid.UUID | None, Query(alias="site")] = None,
) -> list[BlackoutOut]:
    stmt = select(Blackout).order_by(Blackout.starts_on)
    if site_id is not None:
        stmt = stmt.where(or_(Blackout.site_id.is_(None), Blackout.site_id == site_id))
    return [_blackout_out(b) for b in await session.scalars(stmt)]


@router.post("/blackouts/preview", response_model=BlackoutOut)
async def preview_blackout(
    body: BlackoutIn,
    session: Annotated[AsyncSession, Depends(db)],
) -> BlackoutOut:
    """What creating this closure would break, before creating it.

    The same shape as the floor-plan publish preflight, and for the same reason: an
    admin must look at the number of people who lose a desk before they cause it.
    """
    covered = list(await session.scalars(_covered_bookings(body)))
    return BlackoutOut(
        id=uuid7(),
        site_id=body.site_id,
        floor_id=body.floor_id,
        starts_on=body.starts_on,
        ends_on=body.ends_on,
        reason=body.reason,
        cancels_bookings=body.cancels_bookings,
        affected_bookings=len(covered),
    )


@router.post("/blackouts", response_model=BlackoutOut, status_code=201)
async def create_blackout(
    body: BlackoutIn,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
) -> BlackoutOut:
    """Close a floor, a site, or the organization for a range of days (FR-6.5).

    Cancellation goes through `cancel_booking`, not a bulk UPDATE, so every affected
    person gets the same outbox notification they would from any other cancellation —
    "blocks booking and cancels existing bookings *with notice*" is the requirement, and
    the notice is the part a status update would quietly skip.
    """
    blackout = Blackout(
        id=uuid7(),
        organization_id=user.organization_id,
        site_id=body.site_id,
        floor_id=body.floor_id,
        starts_on=body.starts_on,
        ends_on=body.ends_on,
        reason=body.reason,
        cancels_bookings=body.cancels_bookings,
    )
    session.add(blackout)
    await session.flush()

    cancelled = 0
    if body.cancels_bookings:
        for booking in list(await session.scalars(_covered_bookings(body))):
            await cancel_booking(
                session,
                actor=user,
                booking_id=booking.id,
                reason=body.reason or "the office is closed that day",
            )
            cancelled += 1

    await session.commit()
    return _blackout_out(blackout, affected=cancelled)


@router.delete("/blackouts/{blackout_id}", status_code=204)
async def delete_blackout(
    blackout_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> Response:
    """Reopen the days. Bookings cancelled when it was created are NOT restored — they
    were cancelled, the people were told, and the desks may well be gone."""
    row = await session.scalar(select(Blackout).where(Blackout.id == blackout_id))
    if row is not None:
        await session.delete(row)
        await session.commit()
    return Response(status_code=204)
