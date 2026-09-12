import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import ENUM, TSTZRANGE
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, OrgScopedMixin, PKMixin, TimestampMixin


class BookingStatus(enum.StrEnum):
    confirmed = "confirmed"
    checked_in = "checked_in"
    completed = "completed"
    cancelled = "cancelled"
    released_no_show = "released_no_show"


#: Statuses that hold a resource. Must stay in sync with the partial WHERE clause on
#: bookings_no_overlap (migration 0001) — the exclusion constraint is the real authority.
ACTIVE_STATUSES = (BookingStatus.confirmed, BookingStatus.checked_in)

booking_status_enum = ENUM(
    *[s.value for s in BookingStatus], name="booking_status", create_type=False
)


class Booking(Base, PKMixin, OrgScopedMixin):
    """A (resource, user, time range) claim.

    Double-booking is prevented by a GiST exclusion constraint, not by application
    locking (TDD §6.4). Two phones tapping the same desk resolve in the database.
    """

    __tablename__ = "bookings"

    resource_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("resources.id"))
    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    booked_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))

    time_range: Mapped[object] = mapped_column(TSTZRANGE)
    local_date: Mapped[date] = mapped_column(Date)  # site-local; see app.core.time

    status: Mapped[str] = mapped_column(booking_status_enum, default=BookingStatus.confirmed.value)
    slot: Mapped[str] = mapped_column(String(20), default="full_day")
    series_id: Mapped[uuid.UUID | None] = mapped_column()

    checkin_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_in_method: Mapped[str | None] = mapped_column(String(20))
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str | None] = mapped_column(String(500))

    idempotency_key: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class BookingAttendee(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """In-app attendance (TDD §7.4). There is no calendar integration."""

    __tablename__ = "booking_attendees"

    booking_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    external_email: Mapped[str | None] = mapped_column(String(320))
    response: Mapped[str] = mapped_column(String(20), default="invited")
    invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CheckinEvent(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Raw coordinates are never stored — only a boolean and a coarse bucket (PRD §9.4)."""

    __tablename__ = "checkin_events"

    booking_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bookings.id", ondelete="CASCADE"))
    method: Mapped[str] = mapped_column(String(20))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    client_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    geofence_pass: Mapped[bool | None] = mapped_column(Boolean)
    raw_distance_bucket: Mapped[str | None] = mapped_column(String(20))
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("devices.id"))


class Absence(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "absences"
    __table_args__ = (UniqueConstraint("user_id", "local_date"),)

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    local_date: Mapped[date] = mapped_column(Date)
    kind: Mapped[str] = mapped_column(String(20))  # remote | leave | travel
