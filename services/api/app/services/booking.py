"""Booking creation and cancellation (TDD §10.2).

The conflict guarantee is the database's, not this module's: `bookings_no_overlap` is a
GiST exclusion constraint, so two concurrent requests for one desk resolve in Postgres and
the loser surfaces here as an ExclusionViolation. There is deliberately no application
locking anywhere in this path.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from asyncpg.exceptions import ExclusionViolationError
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import Range
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound, PolicyViolation, ResourceUnavailable, Violation
from app.core.ids import uuid7
from app.core.time import local_time_to_utc, materialize_opening_hours, now_utc
from app.models import (
    Booking,
    BookingStatus,
    Outbox,
    Policy,
    Resource,
    Site,
    User,
    ZonePermission,
)
from app.policy import codes
from app.policy.context import BookingContext, PolicySet
from app.policy.engine import blocking, evaluate
from app.policy.rules import P0_RULES, DelegationAllowed
from app.services import restrictions

#: Local wall-clock boundary between the morning and afternoon half-day slots.
HALF_DAY_BOUNDARY = time(13, 0)


@dataclass(frozen=True)
class BookingRequest:
    resource_id: uuid.UUID
    local_date: date
    slot: str = "full_day"
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    user_id: uuid.UUID | None = None
    idempotency_key: str | None = None


def resolve_window(
    site: Site, local_date: date, slot: str, starts_at: datetime | None, ends_at: datetime | None
) -> tuple[datetime, datetime]:
    """Turn a slot into a concrete UTC range.

    Half-days are defined against the site's wall clock, so 'morning' means morning where
    the desk physically is — not where the phone happens to be (TDD §5).
    """
    if slot == "custom":
        if starts_at is None or ends_at is None:
            raise PolicyViolation(
                "custom slot requires starts_at and ends_at",
                violations=[Violation(code="booking.custom_range_required", params={})],
            )
        return starts_at, ends_at

    hours = materialize_opening_hours(site.opening_hours or {}, site.timezone, local_date)
    if hours is None:
        raise PolicyViolation(
            "site is closed on this date",
            violations=[
                Violation(
                    code=codes.OUTSIDE_OPENING_HOURS,
                    params={"date": local_date.isoformat(), "closed": True},
                )
            ],
        )
    opens, closes = hours
    midday = local_time_to_utc(site.timezone, local_date, HALF_DAY_BOUNDARY)
    if slot == "am":
        return opens, min(midday, closes)
    if slot == "pm":
        return max(midday, opens), closes
    return opens, closes


async def _load_context(
    session: AsyncSession,
    *,
    actor: User,
    subject: User,
    resource: Resource,
    site: Site,
    local_date: date,
    starts_at: datetime,
    ends_at: datetime,
) -> BookingContext:
    """Pre-load everything the rules need, so rule evaluation performs no I/O (TDD §9)."""
    subject_bookings = tuple(
        await session.scalars(
            select(Booking).where(
                Booking.user_id == subject.id,
                Booking.status.in_([BookingStatus.confirmed.value, BookingStatus.checked_in.value]),
                Booking.local_date >= local_date - timedelta(days=1),
            )
        )
    )
    site_count = await session.scalar(
        text("""
            SELECT count(*) FROM bookings
            WHERE site_id = :site AND local_date = :d
              AND status IN ('confirmed', 'checked_in')
        """),
        {"site": site.id, "d": local_date},
    )
    policies = await session.scalars(select(Policy).where(Policy.enabled.is_(True)))

    # Zone access is judged by the SUBJECT's groups, not the actor's: a team lead
    # booking for someone else must not lend them their own access (FR-2.10, FR-6.4).
    subject_groups = await restrictions.group_ids_for(session, subject.id)
    zone_permissions: tuple[ZonePermission, ...] = ()
    if resource.zone_id is not None:
        by_zone = await restrictions.zone_permissions_for(session, [resource.zone_id])
        zone_permissions = tuple(by_zone.get(resource.zone_id, ()))
    blackouts = tuple(
        await restrictions.blackouts_for(session, site_id=site.id, start=local_date, end=local_date)
    )

    return BookingContext(
        organization_id=subject.organization_id,
        actor=actor,
        subject=subject,
        site=site,
        resource=resource,
        starts_at=starts_at,
        ends_at=ends_at,
        local_date=local_date,
        subject_bookings=subject_bookings,
        site_bookings_today=int(site_count or 0),
        policies=PolicySet.resolve(list(policies)),
        now=now_utc(),
        subject_group_ids=subject_groups,
        zone_permissions=zone_permissions,
        blackouts=blackouts,
    )


async def create_booking(
    session: AsyncSession,
    *,
    actor: User,
    request: BookingRequest,
    actor_may_delegate: bool = False,
) -> Booking:
    if request.idempotency_key:
        existing = await session.scalar(
            select(Booking).where(
                Booking.booked_by_user_id == actor.id,
                Booking.idempotency_key == request.idempotency_key,
            )
        )
        if existing is not None:
            return existing  # replay, not a second booking

    resource = await session.scalar(select(Resource).where(Resource.id == request.resource_id))
    if resource is None:
        raise NotFound("Resource not found")
    site = await session.scalar(select(Site).where(Site.id == resource.site_id))
    if site is None:
        raise NotFound("Site not found")

    subject = actor
    if request.user_id and request.user_id != actor.id:
        subject = await session.scalar(select(User).where(User.id == request.user_id))
        if subject is None:
            raise NotFound("User not found")

    starts_at, ends_at = resolve_window(
        site, request.local_date, request.slot, request.starts_at, request.ends_at
    )

    ctx = await _load_context(
        session,
        actor=actor,
        subject=subject,
        resource=resource,
        site=site,
        local_date=request.local_date,
        starts_at=starts_at,
        ends_at=ends_at,
    )
    violations = evaluate(ctx, rules=(*P0_RULES, DelegationAllowed(actor_may_delegate)))
    if blocking(violations):
        raise PolicyViolation("Booking refused by policy", violations=violations)

    booking = Booking(
        id=uuid7(),
        organization_id=subject.organization_id,
        resource_id=resource.id,
        site_id=site.id,
        user_id=subject.id,
        booked_by_user_id=actor.id,
        time_range=Range(starts_at, ends_at, bounds="[)"),  # half-open (TDD §6.4)
        local_date=request.local_date,
        status=BookingStatus.confirmed.value,
        slot=request.slot,
        idempotency_key=request.idempotency_key,
        created_at=now_utc(),
    )
    session.add(booking)
    # Side effects are written in the same transaction as the state change (TDD §15.1),
    # so a booking can never exist without its notification having been enqueued.
    session.add(
        Outbox(
            id=uuid7(),
            organization_id=subject.organization_id,
            aggregate_type="booking",
            aggregate_id=booking.id,
            event_type="booking.confirmed",
            payload={"booking_id": str(booking.id), "user_id": str(subject.id)},
            available_at=now_utc(),
        )
    )

    # Read anything needed for the error path BEFORE flushing: a rollback expires the
    # ORM objects, and touching an expired attribute afterwards triggers lazy IO in a
    # context that cannot await it.
    resource_code = resource.code

    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        if isinstance(exc.orig.__cause__, ExclusionViolationError) or "bookings_no_overlap" in str(
            exc.orig
        ):
            raise ResourceUnavailable(
                "That resource was taken while you were booking",
                violations=[
                    Violation(
                        code=codes.RESOURCE_UNAVAILABLE,
                        params={"resource_code": resource_code},
                    )
                ],
            ) from exc
        raise
    return booking


async def cancel_booking(
    session: AsyncSession, *, actor: User, booking_id: uuid.UUID, reason: str | None = None
) -> Booking:
    booking = await session.scalar(select(Booking).where(Booking.id == booking_id))
    if booking is None:
        raise NotFound("Booking not found")
    if booking.status in (BookingStatus.cancelled.value, BookingStatus.released_no_show.value):
        return booking  # idempotent

    booking.status = BookingStatus.cancelled.value
    booking.cancelled_at = now_utc()
    booking.cancel_reason = reason
    session.add(
        Outbox(
            id=uuid7(),
            organization_id=booking.organization_id,
            aggregate_type="booking",
            aggregate_id=booking.id,
            event_type="booking.cancelled",
            payload={"booking_id": str(booking.id), "cancelled_by": str(actor.id)},
            available_at=now_utc(),
        )
    )
    await session.flush()
    return booking
