import uuid
from datetime import date, time

from sqlalchemy import Boolean, Date, ForeignKey, Integer, String, Time
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, OrgScopedMixin, PKMixin, TimestampMixin


class Policy(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Resolved group > site > org, most specific wins per rule_type (TDD §9)."""

    __tablename__ = "policies"

    scope_type: Mapped[str] = mapped_column(String(20))  # org | site | group
    scope_id: Mapped[uuid.UUID | None] = mapped_column()
    rule_type: Mapped[str] = mapped_column(String(50))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)


class ZonePermission(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "zone_permissions"

    zone_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("zones.id", ondelete="CASCADE"))
    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"))
    mode: Mapped[str] = mapped_column(String(20), default="exclusive")
    opens_at_local: Mapped[time | None] = mapped_column(Time)


class Blackout(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "blackouts"

    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    floor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("floors.id", ondelete="CASCADE"))
    starts_on: Mapped[date] = mapped_column(Date)
    ends_on: Mapped[date] = mapped_column(Date)
    reason: Mapped[str | None] = mapped_column(String(500))
    cancels_bookings: Mapped[bool] = mapped_column(Boolean, default=False)
