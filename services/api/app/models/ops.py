import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, OrgScopedMixin, PKMixin, TimestampMixin


class Outbox(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Transactional outbox (TDD §15.1): side effects are written in the same
    transaction as the state change, then delivered at-least-once by workers."""

    __tablename__ = "outbox"

    aggregate_type: Mapped[str] = mapped_column(String(50))
    aggregate_id: Mapped[uuid.UUID] = mapped_column()
    event_type: Mapped[str] = mapped_column(String(100))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(2000))


class AuditLog(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "audit_log"

    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(100))
    target_type: Mapped[str] = mapped_column(String(50))
    target_id: Mapped[uuid.UUID | None] = mapped_column()
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    ip_hash: Mapped[str | None] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
