import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, OrgScopedMixin, PKMixin, TimestampMixin


class ResourceKind(enum.StrEnum):
    desk = "desk"
    room = "room"


class Site(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "sites"

    name: Mapped[str] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(String(500))
    timezone: Mapped[str] = mapped_column(String(64))  # IANA. The authority for "a day" (TDD §5)
    geo_lat: Mapped[float | None] = mapped_column(Float)
    geo_lng: Mapped[float | None] = mapped_column(Float)
    geofence_radius_m: Mapped[int] = mapped_column(Integer, default=150)
    opening_hours: Mapped[dict] = mapped_column(JSONB, default=dict)
    daily_capacity_cap: Mapped[int | None] = mapped_column(Integer)
    checkin_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(30), default="active")


class FloorPlanAsset(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "floor_plan_assets"

    original_key: Mapped[str] = mapped_column(String(500))
    rendered_key: Mapped[str | None] = mapped_column(String(500))
    width_px: Mapped[int] = mapped_column(Integer)
    height_px: Mapped[int] = mapped_column(Integer)
    content_type: Mapped[str] = mapped_column(String(100))
    checksum: Mapped[str | None] = mapped_column(String(64))


class Floor(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "floors"

    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    plan_asset_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("floor_plan_assets.id"))
    plan_width_px: Mapped[int | None] = mapped_column(Integer)
    plan_height_px: Mapped[int | None] = mapped_column(Integer)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Zone(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "zones"

    floor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("floors.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(30), default="neighborhood")
    polygon: Mapped[list] = mapped_column(JSONB, default=list)  # normalized 0..1 (TDD §14.2)
    color: Mapped[str | None] = mapped_column(String(20))


class Resource(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Desks and rooms are one table — that is what lets parking/lockers arrive later
    without touching the booking engine (TDD §4)."""

    __tablename__ = "resources"
    __table_args__ = (UniqueConstraint("site_id", "code"),)

    site_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"))
    floor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("floors.id", ondelete="CASCADE"))
    zone_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("zones.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(20))
    code: Mapped[str] = mapped_column(String(50))
    name: Mapped[str | None] = mapped_column(String(200))
    position: Mapped[dict] = mapped_column(JSONB, default=dict)  # {x, y, rotation} normalized
    capacity: Mapped[int] = mapped_column(Integer, default=1)
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict)
    assigned_to_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    bookable: Mapped[bool] = mapped_column(Boolean, default=True)
    out_of_service_reason: Mapped[str | None] = mapped_column(String(500))
    qr_key_id: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="active")
