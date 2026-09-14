"""Booking and availability endpoints (TDD §10, §11)."""

import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import Principal, current_principal, current_user, db
from app.api.v1.admin import plan_url
from app.core.errors import NotFound, PolicyViolation
from app.core.time import materialize_opening_hours, now_utc, to_local_date
from app.models import Booking, Floor, FloorPlanAsset, Resource, Site, User, Zone
from app.models.booking import ACTIVE_STATUSES
from app.services import availability as availability_service
from app.services import restrictions
from app.services.booking import BookingRequest, cancel_booking, create_booking, resolve_window

router = APIRouter(tags=["bookings"])

DELEGATE_ROLES = {"team_lead", "site_admin", "org_admin"}

Slot = Literal["full_day", "am", "pm", "custom"]


class ViolationOut(BaseModel):
    code: str
    params: dict


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
    #: Why *this* viewer may not book it, when the reason is about them rather than the
    #: desk — a zone held for another team (FR-6.4). Rendered from the code like any
    #: other refusal, so the plan can explain itself without new message plumbing.
    restriction: ViolationOut | None = None


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

    # A blacked-out day refuses here rather than returning a plan full of desks that
    # cannot be booked, exactly as a closed day already does (FR-6.5). The client
    # renders the code, which it already handles.
    blackouts = await restrictions.blackouts_for(
        session, site_id=site.id, start=local_date, end=local_date
    )
    closed = restrictions.blackout_violation(blackouts, local_date=local_date, floor_id=floor_id)
    if closed is not None:
        raise PolicyViolation("date is blacked out", violations=[closed])

    rows = await availability_service.floor_availability(
        session,
        floor_id=floor_id,
        window_start=starts_at,
        window_end=ends_at,
        kind=kind,
        min_capacity=min_capacity,
        filters=filters,
    )
    zones = list(await session.scalars(select(Zone).where(Zone.floor_id == floor_id)))

    # The same decision function the booking rule uses (FR-6.4). Computing "can they
    # book here" a second way here is how a desk comes to render green and then refuse.
    member_of = await restrictions.group_ids_for(session, user.id)
    permissions = await restrictions.zone_permissions_for(session, [z.id for z in zones])
    now = now_utc()
    zone_blocks: dict[uuid.UUID, ViolationOut] = {}
    for zone in zones:
        violation = restrictions.zone_violation(
            permissions.get(zone.id, []),
            member_of=member_of,
            site_timezone=site.timezone,
            local_date=local_date,
            now=now,
        )
        if violation is not None:
            zone_blocks[zone.id] = ViolationOut(code=violation.code, params=violation.params)

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
        available=sum(1 for r in rows if r.available and r.zone_id not in zone_blocks),
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
                # Restricted desks are not "available" to this viewer, so they cannot
                # render as free. `bookable` stays a fact about the desk.
                available=r.available and r.zone_id not in zone_blocks,
                bookable=r.bookable,
                out_of_service_reason=r.out_of_service_reason,
                occupied_by_me=r.occupied_by == user.id,
                restriction=zone_blocks.get(r.zone_id),
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


class DayBookingOut(BaseModel):
    """The user's own booking on a day, flattened enough that the home screen needs no
    second call to name the desk or link to its floor."""

    id: uuid.UUID
    resource_code: str | None
    floor_id: uuid.UUID
    floor_name: str
    status: str
    starts_at: datetime
    ends_at: datetime


class DayAvailabilityOut(BaseModel):
    local_date: date
    #: False when the site does not open at all — a weekend. `total` and `available`
    #: are then both zero, which is not the same as "full".
    is_open: bool
    total: int
    available: int
    #: True when a blackout closes the day (FR-6.5). Distinct from `is_open`: the office
    #: keeps its usual hours and an admin has closed it. A separate flag from the reason
    #: because the reason is optional free text — inferring "closed" from a non-empty
    #: string makes a reasonless closure look open, and makes a missing field look shut.
    blackout: bool = False
    blackout_reason: str | None = None
    my_booking: DayBookingOut | None = None


class WeekAvailabilityOut(BaseModel):
    site_id: uuid.UUID
    site_name: str
    site_timezone: str
    #: Today *at the site*, which is what the home screen must highlight — not the
    #: device's today (TDD §5).
    today: date
    days: list[DayAvailabilityOut]


@router.get("/sites/{site_id}/availability", response_model=WeekAvailabilityOut)
async def site_week_availability(
    site_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    start: Annotated[date | None, Query(alias="from")] = None,
    days: Annotated[int, Query(ge=1, le=31)] = 7,
    kind: str = "desk",
) -> WeekAvailabilityOut:
    """A week of days at one site, with how full each is and what the user already has.

    This is what FR-2.1 asks the home screen to show, and it exists because the only
    other availability endpoint is per-floor: answering "how does my week look" from it
    would take floors x days calls on every app open.
    """
    site = await session.scalar(select(Site).where(Site.id == site_id))
    if site is None:
        raise NotFound("Site not found")

    today = to_local_date(site.timezone, now_utc())
    first = start or today
    dates = [first + timedelta(days=i) for i in range(days)]

    # A closed day never reaches the database: there is no window to ask about, and
    # "0 of 0 free" would read as "full" rather than "shut".
    windows: dict[int, tuple[datetime, datetime]] = {}
    for i, day in enumerate(dates):
        hours = materialize_opening_hours(site.opening_hours or {}, site.timezone, day)
        if hours is not None:
            windows[i] = hours

    counts = await availability_service.week_counts(
        session, site_id=site_id, windows=windows, kind=kind
    )

    # A blacked-out day must not advertise free desks it will then refuse (FR-6.5).
    # Site-wide and org-wide rows only: a single floor closing does not close the site.
    blackouts = await restrictions.blackouts_for(
        session, site_id=site_id, start=dates[0], end=dates[-1]
    )
    blocked = {
        day: (hit.reason or None)
        for day in dates
        if (hit := restrictions.blackout_hit(blackouts, local_date=day, floor_id=None))
    }

    rows = await session.execute(
        select(Booking, Resource.code, Floor.id, Floor.name)
        .join(Resource, Resource.id == Booking.resource_id)
        .join(Floor, Floor.id == Resource.floor_id)
        .where(
            Booking.user_id == user.id,
            Booking.local_date >= dates[0],
            Booking.local_date <= dates[-1],
            Booking.status.in_(ACTIVE_STATUSES),
        )
    )
    mine: dict[date, DayBookingOut] = {
        booking.local_date: DayBookingOut(
            id=booking.id,
            resource_code=code,
            floor_id=floor_id,
            floor_name=floor_name,
            status=booking.status,
            # `bookings` stores one tstzrange, not two columns — the range is what
            # the exclusion constraint indexes.
            starts_at=booking.time_range.lower,
            ends_at=booking.time_range.upper,
        )
        for booking, code, floor_id, floor_name in rows
    }

    return WeekAvailabilityOut(
        site_id=site_id,
        site_name=site.name,
        site_timezone=site.timezone,
        today=today,
        days=[
            DayAvailabilityOut(
                local_date=day,
                is_open=i in windows,
                total=counts[i].total if i in counts else 0,
                available=0 if day in blocked else (counts[i].available if i in counts else 0),
                blackout=day in blocked,
                blackout_reason=blocked.get(day),
                my_booking=mine.get(day),
            )
            for i, day in enumerate(dates)
        ],
    )
