"""Outbox dispatcher (TDD §15.1).

Delivery is at-least-once and every handler must be idempotent. Claiming uses
FOR UPDATE SKIP LOCKED so any number of workers can run without coordination: two
workers never take the same row, and a crashed worker's rows become claimable again
once their lock expires rather than being stranded.

Tenant discipline: the claim reads `outbox_dispatch`, which carries no tenant content
and is therefore not under RLS. Everything after that runs inside a session bound to the
claimed row's organization, so payload reads and handler queries are isolated exactly
like a request would be.
"""

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta

import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import SessionFactory, _apply_tenant
from app.models import Booking, Outbox, Resource, Site, User
from app.services.notifications import LoggingPushSender, Notification, Notifier, SmtpEmailSender

log = structlog.get_logger()

#: After this many attempts an event is dead-lettered rather than retried forever.
MAX_ATTEMPTS = 6
#: How long a claim is held before another worker may retry it.
LOCK_SECONDS = 60
BATCH_SIZE = 100


def backoff_seconds(attempts: int) -> int:
    """Exponential with a ceiling: 2, 4, 8, 16, 32, 64 … capped at 15 minutes."""
    return min(2**attempts, 900)


@dataclass(frozen=True)
class Claimed:
    outbox_id: uuid.UUID
    organization_id: uuid.UUID
    attempts: int


CLAIM_SQL = text("""
    UPDATE outbox_dispatch SET
        locked_until = now() + make_interval(secs => :lock_seconds),
        attempts = attempts + 1
    WHERE outbox_id IN (
        SELECT outbox_id FROM outbox_dispatch
        WHERE processed_at IS NULL
          AND failed_at IS NULL
          AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY available_at
        FOR UPDATE SKIP LOCKED
        LIMIT :batch
    )
    RETURNING outbox_id, organization_id, attempts
""")


async def claim(session: AsyncSession, *, batch: int = BATCH_SIZE) -> list[Claimed]:
    rows = await session.execute(CLAIM_SQL, {"lock_seconds": LOCK_SECONDS, "batch": batch})
    return [Claimed(**dict(r)) for r in rows.mappings()]


# --------------------------------------------------------------------- handlers

Handler = Callable[[AsyncSession, Outbox, Notifier], Awaitable[None]]


async def _booking_context(session: AsyncSession, booking_id: uuid.UUID):
    booking = await session.scalar(select(Booking).where(Booking.id == booking_id))
    if booking is None:
        return None, None, None, None
    user = await session.scalar(select(User).where(User.id == booking.user_id))
    resource = await session.scalar(select(Resource).where(Resource.id == booking.resource_id))
    site = await session.scalar(select(Site).where(Site.id == booking.site_id))
    return booking, user, resource, site


async def handle_booking_confirmed(
    session: AsyncSession, event: Outbox, notifier: Notifier
) -> None:
    booking, user, resource, site = await _booking_context(
        session, uuid.UUID(event.payload["booking_id"])
    )
    if booking is None or user is None:
        # The booking was deleted before delivery. Dropping the event is correct — there
        # is nothing to notify about — and must not be treated as a failure to retry.
        log.info("outbox.booking_confirmed.skipped", event_id=str(event.id))
        return
    await notifier.send(
        Notification(
            user_id=str(user.id),
            email=user.email,
            title="Desk booked",
            body=(
                f"{resource.code if resource else 'Your desk'} at "
                f"{site.name if site else 'the office'} on {booking.local_date}."
            ),
            link=f"deskflow://booking/{booking.id}",
        )
    )


async def handle_booking_cancelled(
    session: AsyncSession, event: Outbox, notifier: Notifier
) -> None:
    booking, user, resource, site = await _booking_context(
        session, uuid.UUID(event.payload["booking_id"])
    )
    if booking is None or user is None:
        log.info("outbox.booking_cancelled.skipped", event_id=str(event.id))
        return
    await notifier.send(
        Notification(
            user_id=str(user.id),
            email=user.email,
            title="Booking cancelled",
            body=(
                f"{resource.code if resource else 'Your desk'} at "
                f"{site.name if site else 'the office'} on {booking.local_date} was cancelled."
            ),
            link="deskflow://bookings",
        )
    )


HANDLERS: dict[str, Handler] = {
    "booking.confirmed": handle_booking_confirmed,
    "booking.cancelled": handle_booking_cancelled,
}


def default_notifier() -> Notifier:
    return Notifier(senders=(LoggingPushSender(), SmtpEmailSender()))


# ------------------------------------------------------------------- dispatcher


async def _mark_processed(session: AsyncSession, outbox_id: uuid.UUID) -> None:
    await session.execute(
        text("""
            UPDATE outbox_dispatch
            SET processed_at = now(), locked_until = NULL, last_error = NULL
            WHERE outbox_id = :id
        """),
        {"id": outbox_id},
    )


async def _mark_retry(session: AsyncSession, claimed: Claimed, error: str) -> None:
    """Reschedule with backoff, or dead-letter once attempts are exhausted.

    Dead-lettering rather than retrying forever is deliberate: an event that has failed
    six times is not going to succeed on the seventh, and a queue that retries forever
    hides the failure instead of surfacing it.
    """
    if claimed.attempts >= MAX_ATTEMPTS:
        await session.execute(
            text("""
                UPDATE outbox_dispatch
                SET failed_at = now(), locked_until = NULL, last_error = :err
                WHERE outbox_id = :id
            """),
            {"id": claimed.outbox_id, "err": error[:2000]},
        )
        log.error(
            "outbox.dead_letter",
            outbox_id=str(claimed.outbox_id),
            attempts=claimed.attempts,
            error=error,
        )
        return

    delay = backoff_seconds(claimed.attempts)
    await session.execute(
        text("""
            UPDATE outbox_dispatch
            SET available_at = now() + make_interval(secs => :delay),
                locked_until = NULL, last_error = :err
            WHERE outbox_id = :id
        """),
        {"id": claimed.outbox_id, "delay": delay, "err": error[:2000]},
    )
    log.warning(
        "outbox.retry_scheduled",
        outbox_id=str(claimed.outbox_id),
        attempts=claimed.attempts,
        retry_in_seconds=delay,
    )


async def process_one(claimed: Claimed, notifier: Notifier) -> bool:
    """Handle a single claimed event in its own tenant-bound transaction."""
    async with SessionFactory() as session:
        await session.begin()
        await _apply_tenant(session, claimed.organization_id)
        try:
            event = await session.scalar(select(Outbox).where(Outbox.id == claimed.outbox_id))
            if event is None:
                # Visible in dispatch but not under its own tenant: the payload was
                # deleted. Nothing to do, and retrying will not bring it back.
                await _mark_processed(session, claimed.outbox_id)
                await session.commit()
                return True

            handler = HANDLERS.get(event.event_type)
            if handler is None:
                raise RuntimeError(f"no handler for event type {event.event_type!r}")

            await handler(session, event, notifier)
            await _mark_processed(session, claimed.outbox_id)
            await session.commit()
            return True
        except Exception as exc:  # noqa: BLE001 - any handler failure is a retry
            await session.rollback()
            await session.begin()
            await _apply_tenant(session, claimed.organization_id)
            await _mark_retry(session, claimed, f"{type(exc).__name__}: {exc}")
            await session.commit()
            return False


async def drain(*, batch: int = BATCH_SIZE, notifier: Notifier | None = None) -> dict[str, int]:
    """Claim and process one batch. Returns counts for logging and tests."""
    notifier = notifier or default_notifier()
    async with SessionFactory() as session:
        await session.begin()
        claimed = await claim(session, batch=batch)
        await session.commit()

    delivered = 0
    for c in claimed:
        if await process_one(c, notifier):
            delivered += 1

    if claimed:
        log.info("outbox.drained", claimed=len(claimed), delivered=delivered)
    return {"claimed": len(claimed), "delivered": delivered, "failed": len(claimed) - delivered}


def stale_lock_cutoff() -> timedelta:
    """Locks older than this are considered abandoned by a dead worker."""
    return timedelta(seconds=LOCK_SECONDS)


__all__ = ["drain", "process_one", "claim", "HANDLERS", "default_notifier", "backoff_seconds"]


async def main() -> None:  # pragma: no cover - manual runner
    import asyncio

    from app.core.logging import configure_logging

    configure_logging()
    log.info("outbox.worker.started")
    while True:
        result = await drain()
        await asyncio.sleep(1 if result["claimed"] else 5)


if __name__ == "__main__":  # pragma: no cover
    import asyncio

    asyncio.run(main())
