"""Booking and availability endpoints (TDD §10, §11)."""

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, current_principal, current_user, db
from app.api.v1.admin import plan_url
from app.core.errors import NotFound
from app.models import Booking, Floor, FloorPlanAsset, Resource, Site, User, Zone
from app.services import availability as availability_service
from app.services.booking import BookingRequest, cancel_booking, create_booking, resolve_window

router = APIRouter(tags=["bookings"])

DELEGATE_ROLES = {"team_lead", "site_admin", "org_admin"}

Slot = Literal["full_day", "am", "pm", "custom"]


class ResourceAvailabilityOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str | None
    kind: str
    capacity: int
    position: dict
    attributes: dict
    zone_id: uuid.UUID | None
    available: bool
    bookable: bool
    out_of_service_reason: str | None
    occupied_by_me: bool


class ZoneOut(BaseModel):
    id: uuid.UUID
    name: str
    polygon: list
    color: str | None


class PlanOut(BaseModel):
    """The floor's published plan image, as a signed short-lived URL (TDD §11, §14.3).

    Signed rather than bearer-authenticated because the renderer fetches it with an
    <Image>, which cannot set an Authorization header. Null until an admin publishes a
    plan, and the viewer draws on a plain ground until then.
    """

    url: str
    width_px: int
    height_px: int
    aspect_ratio: float


class AvailabilityOut(BaseModel):
    floor_id: uuid.UUID
    local_date: date
    slot: Slot
    starts_at: datetime
    ends_at: datetime
    site_timezone: str
    total: int
    available: int
    resources: list[ResourceAvailabilityOut]
    #: Returned alongside resources because the plan needs both to draw one frame.
    zones: list[ZoneOut]
    plan: PlanOut | None = None


class BookingOut(BaseModel):
    id: uuid.UUID
    resource_id: uuid.UUID
    resource_code: str | None = None
    site_id: uuid.UUID
    user_id: uuid.UUID
    local_date: date
    slot: str
    status: str
    starts_at: datetime
    ends_at: datetime
    site_timezone: str | None = None


class CreateBookingIn(BaseModel):
    resource_id: uuid.UUID
    local_date: date
    slot: Slot = "full_day"
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    user_id: uuid.UUID | None = Field(
        default=None, description="Book on behalf of another user (FR-2.10)."
    )


def _to_out(booking: Booking, resource_code: str | None, tz: str | None) -> BookingOut:
    lower, upper = booking.time_range.lower, booking.time_range.upper
    return BookingOut(
        id=booking.id,
        resource_id=booking.resource_id,
        resource_code=resource_code,
        site_id=booking.site_id,
        user_id=booking.user_id,
        local_date=booking.local_date,
        slot=booking.slot,
        status=str(booking.status),
        starts_at=lower,
        ends_at=upper,
        site_timezone=tz,
    )


@router.get("/floors/{floor_id}/availability", response_model=AvailabilityOut)
async def floor_availability(
    floor_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    local_date: Annotated[date, Query(alias="date")],
    slot: Slot = "full_day",
    kind: str | None = None,
    min_capacity: int | None = None,
    filters: Annotated[
        str | None, Query(description='JSON attribute filter, e.g. {"sit_stand":true}')
    ] = None,
) -> AvailabilityOut:
    floor = await session.scalar(select(Floor).where(Floor.id == floor_id))
    if floor is None:
        raise NotFound("Floor not found")
    site = await session.scalar(select(Site).where(Site.id == floor.site_id))
    if site is None:
        raise NotFound("Site not found")

    starts_at, ends_at = resolve_window(site, local_date, slot, None, None)
    rows = await availability_service.floor_availability(
        session,
        floor_id=floor_id,
        window_start=starts_at,
        window_end=ends_at,
        kind=kind,
        min_capacity=min_capacity,
        filters=filters,
    )
    zones = await session.scalars(select(Zone).where(Zone.floor_id == floor_id))

    # The PUBLISHED plan only. `floors.plan_asset_id` is moved by publishing, so an
    # admin's unpublished replacement cannot reach an employee's screen from here.
    plan_out: PlanOut | None = None
    if floor.plan_asset_id:
        asset = await session.scalar(
            select(FloorPlanAsset).where(FloorPlanAsset.id == floor.plan_asset_id)
        )
        if asset and asset.height_px:
            plan_out = PlanOut(
                url=plan_url(asset.id, asset.organization_id),
                width_px=asset.width_px,
                height_px=asset.height_px,
                aspect_ratio=round(asset.width_px / asset.height_px, 6),
            )

    return AvailabilityOut(
        floor_id=floor_id,
        local_date=local_date,
        slot=slot,
        starts_at=starts_at,
        ends_at=ends_at,
        site_timezone=site.timezone,
        total=len(rows),
        available=sum(1 for r in rows if r.available),
        resources=[
            ResourceAvailabilityOut(
                id=r.id,
                code=r.code,
                name=r.name,
                kind=r.kind,
                capacity=r.capacity,
                position=r.position,
                attributes=r.attributes,
                zone_id=r.zone_id,
                available=r.available,
                bookable=r.bookable,
                out_of_service_reason=r.out_of_service_reason,
                occupied_by_me=r.occupied_by == user.id,
            )
            for r in rows
        ],
        zones=[
            ZoneOut(id=z.id, name=z.name, polygon=z.polygon or [], color=z.color) for z in zones
        ],
        plan=plan_out,
    )


@router.post("/bookings", response_model=BookingOut, status_code=201)
async def create(
    body: CreateBookingIn,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    principal: Annotated[Principal, Depends(current_principal)],
    response: Response,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> BookingOut:
    booking = await create_booking(
        session,
        actor=user,
        request=BookingRequest(
            resource_id=body.resource_id,
            local_date=body.local_date,
            slot=body.slot,
            starts_at=body.starts_at,
            ends_at=body.ends_at,
            user_id=body.user_id,
            idempotency_key=idempotency_key,
        ),
        actor_may_delegate=bool(DELEGATE_ROLES & set(principal.roles)),
    )
    resource = await session.scalar(select(Resource).where(Resource.id == booking.resource_id))
    site = await session.scalar(select(Site).where(Site.id == booking.site_id))
    response.headers["Location"] = f"/v1/bookings/{booking.id}"
    return _to_out(booking, resource.code if resource else None, site.timezone if site else None)


@router.get("/bookings", response_model=list[BookingOut])
async def list_bookings(
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> list[BookingOut]:
    stmt = (
        select(Booking, Resource.code, Site.timezone)
        .join(Resource, Resource.id == Booking.resource_id)
        .join(Site, Site.id == Booking.site_id)
        .where(Booking.user_id == user.id)
    )
    if date_from:
        stmt = stmt.where(Booking.local_date >= date_from)
    if date_to:
        stmt = stmt.where(Booking.local_date <= date_to)
    rows = await session.execute(stmt.order_by(Booking.local_date))
    return [_to_out(b, code, tz) for b, code, tz in rows.all()]


@router.delete("/bookings/{booking_id}", response_model=BookingOut)
async def cancel(
    booking_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    reason: str | None = None,
) -> BookingOut:
    booking = await cancel_booking(session, actor=user, booking_id=booking_id, reason=reason)
    resource = await session.scalar(select(Resource).where(Resource.id == booking.resource_id))
    site = await session.scalar(select(Site).where(Site.id == booking.site_id))
    return _to_out(booking, resource.code if resource else None, site.timezone if site else None)
