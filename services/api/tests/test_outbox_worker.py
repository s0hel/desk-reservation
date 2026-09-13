"""Outbox dispatcher tests (TDD §15.1, §20).

The properties under test are the ones that make at-least-once delivery safe: no two
workers take the same row, failures back off instead of spinning, and an event that
cannot succeed is dead-lettered where someone will see it rather than retried forever.
"""

import asyncio
import uuid

import pytest
from sqlalchemy import text

from app.core.ids import uuid7
from app.db.session import SessionFactory, _apply_tenant
from app.models import Organization
from app.services.notifications import Notification, Notifier
from app.workers import outbox as worker
from app.workers.outbox import MAX_ATTEMPTS, Claimed, backoff_seconds, claim, drain, process_one


class RecordingSender:
    """A real sender that records instead of delivering."""

    name = "recording"

    def __init__(self, fail_with: Exception | None = None):
        self.sent: list[Notification] = []
        self.fail_with = fail_with

    async def send(self, notification: Notification) -> None:
        if self.fail_with:
            raise self.fail_with
        self.sent.append(notification)


def notifier_of(sender) -> Notifier:
    return Notifier(senders=(sender,))


@pytest.fixture(autouse=True)
async def empty_queue() -> None:
    """Start each test from an empty dispatch queue.

    `outbox_dispatch` is deliberately global (migration 0002) — that is the whole point
    of splitting routing from content, and it is what lets a worker find work across
    tenants without BYPASSRLS. The consequence for tests is that a queue is shared
    state: any other test that commits a booking or a cancellation leaves rows here, and
    a drain asserting `claimed == 1` then counts somebody else's event. Scoping the
    assertions per-tenant would test something weaker than what the worker actually
    does, so clear the queue instead.
    """
    async with SessionFactory() as s:
        await s.begin()
        await s.execute(text("DELETE FROM outbox_dispatch"))
        await s.commit()


@pytest.fixture
async def org() -> uuid.UUID:
    org_id = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, org_id)
        s.add(Organization(id=org_id, name="t", slug=f"t-{org_id.hex[:8]}"))
        await s.commit()
    return org_id


async def enqueue(org_id: uuid.UUID, event_type: str, payload: dict) -> uuid.UUID:
    """Insert an outbox row; the trigger creates its dispatch row in the same
    transaction, which is the guarantee the whole pattern rests on."""
    event_id = uuid7()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, org_id)
        await s.execute(
            text("""
                INSERT INTO outbox (id, organization_id, aggregate_type, aggregate_id,
                                    event_type, payload, available_at)
                VALUES (:i, :o, 'test', :i, :t, CAST(:p AS jsonb), now())
            """),
            {"i": event_id, "o": org_id, "t": event_type, "p": __import__("json").dumps(payload)},
        )
        await s.commit()
    return event_id


async def make_booking(org_id: uuid.UUID) -> uuid.UUID:
    """A real booking, so handlers reach the notifier instead of taking the
    aggregate-missing shortcut."""
    site, floor, resource, user, booking = (uuid7() for _ in range(5))
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, org_id)
        await s.execute(
            text("""INSERT INTO sites (id, organization_id, name, timezone)
                    VALUES (:i,:o,'HQ','Europe/Berlin')"""),
            {"i": site, "o": org_id},
        )
        await s.execute(
            text("""INSERT INTO floors (id, organization_id, site_id, name)
                    VALUES (:i,:o,:s,'F1')"""),
            {"i": floor, "o": org_id, "s": site},
        )
        await s.execute(
            text("""INSERT INTO resources (id, organization_id, site_id, floor_id, kind, code)
                    VALUES (:i,:o,:s,:f,'desk','A-01')"""),
            {"i": resource, "o": org_id, "s": site, "f": floor},
        )
        await s.execute(
            text("""INSERT INTO users (id, organization_id, email, display_name)
                    VALUES (:i,:o,:e,'U')"""),
            {"i": user, "o": org_id, "e": f"u-{user.hex[:8]}@t.example"},
        )
        await s.execute(
            text("""INSERT INTO bookings (id, organization_id, resource_id, site_id, user_id,
                                          booked_by_user_id, time_range, local_date, status)
                    VALUES (:i,:o,:r,:s,:u,:u,
                            tstzrange(now(), now() + interval '8 hours', '[)'),
                            current_date, 'confirmed')"""),
            {"i": booking, "o": org_id, "r": resource, "s": site, "u": user},
        )
        await s.commit()
    return booking


async def dispatch_row(outbox_id: uuid.UUID) -> dict:
    async with SessionFactory() as s:
        row = await s.execute(
            text("SELECT * FROM outbox_dispatch WHERE outbox_id = :i"), {"i": outbox_id}
        )
        return dict(row.mappings().one())


# ------------------------------------------------------------------ the trigger


async def test_enqueueing_an_outbox_row_creates_its_dispatch_row(org):
    event_id = await enqueue(org, "test.event", {"x": 1})
    row = await dispatch_row(event_id)
    assert row["organization_id"] == org
    assert row["processed_at"] is None and row["attempts"] == 0


async def test_dispatch_is_visible_without_a_tenant_but_payloads_are_not(org):
    """The whole point of the split: a worker can discover work across tenants without
    being able to read anyone's data (migration 0002)."""
    await enqueue(org, "test.event", {"secret": "value"})
    async with SessionFactory() as s:
        await s.begin()  # deliberately no tenant bound
        dispatch = (await s.execute(text("SELECT count(*) FROM outbox_dispatch"))).scalar_one()
        payloads = (await s.execute(text("SELECT count(*) FROM outbox"))).scalar_one()
        await s.rollback()
    assert dispatch >= 1, "worker cannot see routing rows"
    assert payloads == 0, "payloads leaked outside a tenant binding"


# -------------------------------------------------------------------- claiming


async def test_two_workers_never_claim_the_same_row(org):
    for i in range(10):
        await enqueue(org, "test.event", {"n": i})

    async def claim_batch():
        async with SessionFactory() as s:
            await s.begin()
            got = await claim(s, batch=10)
            await s.commit()
            return {c.outbox_id for c in got}

    a, b = await asyncio.gather(claim_batch(), claim_batch())
    assert a & b == set(), "SKIP LOCKED must prevent overlapping claims"


async def test_claiming_increments_attempts_and_takes_a_lock(org):
    event_id = await enqueue(org, "test.event", {})
    async with SessionFactory() as s:
        await s.begin()
        await claim(s, batch=10)
        await s.commit()
    row = await dispatch_row(event_id)
    assert row["attempts"] == 1 and row["locked_until"] is not None


# ------------------------------------------------------------------- delivery


async def test_successful_delivery_marks_processed_and_stops_redelivery(org):
    booking_id = await make_booking(org)
    event_id = await enqueue(org, "booking.confirmed", {"booking_id": str(booking_id)})
    sender = RecordingSender()

    first = await drain(notifier=notifier_of(sender))
    assert first == {"claimed": 1, "delivered": 1, "failed": 0}
    assert (await dispatch_row(event_id))["processed_at"] is not None
    # Assert something was actually delivered, not merely that nothing failed.
    assert len(sender.sent) == 1
    assert sender.sent[0].title == "Desk booked"
    assert sender.sent[0].link.startswith("deskflow://booking/")

    # A processed event must never be claimed again.
    assert (await drain(notifier=notifier_of(sender)))["claimed"] == 0


async def test_unknown_event_type_is_retried_then_dead_lettered(org):
    event_id = await enqueue(org, "nonsense.event", {})
    for _ in range(MAX_ATTEMPTS):
        async with SessionFactory() as s:  # clear the lock so the next attempt can claim
            await s.begin()
            await s.execute(
                text(
                    "UPDATE outbox_dispatch SET locked_until = NULL, available_at = now()"
                    " WHERE outbox_id = :i"
                ),
                {"i": event_id},
            )
            await s.commit()
        await drain(notifier=notifier_of(RecordingSender()))

    row = await dispatch_row(event_id)
    assert row["failed_at"] is not None, "should be dead-lettered, not retried forever"
    assert "no handler" in (row["last_error"] or "")
    # Dead-lettered rows are out of the claim path entirely.
    assert (await drain(notifier=notifier_of(RecordingSender())))["claimed"] == 0


async def test_a_failing_sender_schedules_a_retry_rather_than_losing_the_event(org):
    booking_id = await make_booking(org)
    event_id = await enqueue(org, "booking.confirmed", {"booking_id": str(booking_id)})
    sender = RecordingSender(fail_with=RuntimeError("smtp down"))

    result = await drain(notifier=notifier_of(sender))
    assert result == {"claimed": 1, "delivered": 0, "failed": 1}

    row = await dispatch_row(event_id)
    assert row["processed_at"] is None and row["failed_at"] is None
    assert "smtp down" in row["last_error"]
    assert row["available_at"] > row["created_at"], "retry must be scheduled into the future"


async def test_a_deleted_booking_is_dropped_not_retried(org):
    """The aggregate is gone, so there is nothing to notify about. Treating that as a
    failure would retry six times and then dead-letter something harmless."""
    event_id = await enqueue(org, "booking.confirmed", {"booking_id": str(uuid7())})
    sender = RecordingSender()
    await drain(notifier=notifier_of(sender))

    assert (await dispatch_row(event_id))["processed_at"] is not None
    assert sender.sent == []


async def test_handler_runs_inside_the_events_tenant(org):
    """process_one must bind the claimed row's organization before touching payloads."""
    event_id = await enqueue(org, "booking.confirmed", {"booking_id": str(uuid7())})
    seen: list[int] = []

    async def spy(session, event, notifier):
        bound = (
            await session.execute(text("SELECT current_setting('app.org_id', true)"))
        ).scalar_one()
        seen.append(bound)

    original = worker.HANDLERS["booking.confirmed"]
    worker.HANDLERS["booking.confirmed"] = spy
    try:
        await process_one(
            Claimed(outbox_id=event_id, organization_id=org, attempts=1),
            notifier_of(RecordingSender()),
        )
    finally:
        worker.HANDLERS["booking.confirmed"] = original

    assert seen == [str(org)]


# --------------------------------------------------------------------- backoff


@pytest.mark.parametrize(
    "attempts,expected", [(0, 1), (1, 2), (2, 4), (5, 32), (10, 900), (50, 900)]
)
def test_backoff_grows_then_caps(attempts, expected):
    assert backoff_seconds(attempts) == expected
