import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, OrgScopedMixin, PKMixin, TimestampMixin


class Organization(Base, PKMixin, TimestampMixin):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    primary_domain: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(30), default="active")
    data_region: Mapped[str] = mapped_column(String(20), default="us")
    settings: Mapped[dict] = mapped_column(JSONB, default=dict)


class OrgDomain(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Email domain -> tenant routing (FR-1.3)."""

    __tablename__ = "org_domains"
    __table_args__ = (UniqueConstraint("domain"),)

    domain: Mapped[str] = mapped_column(String(255))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IdentityProvider(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "identity_providers"

    kind: Mapped[str] = mapped_column(String(30))  # oidc_google | oidc_entra | oidc | magic_link
    issuer: Mapped[str | None] = mapped_column(String(500))
    discovery_url: Mapped[str | None] = mapped_column(String(500))
    client_id: Mapped[str | None] = mapped_column(String(255))
    client_secret_enc: Mapped[str | None] = mapped_column(String(1000))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class User(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320))
    external_id: Mapped[str | None] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(200))
    avatar_url: Mapped[str | None] = mapped_column(String(1000))
    locale: Mapped[str] = mapped_column(String(10), default="en")
    status: Mapped[str] = mapped_column(String(30), default="active")
    home_site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    # FR-5.6 / PRD Q6 — enforced in the query layer, never client-side (TDD §11)
    presence_visibility: Mapped[str] = mapped_column(String(20), default="everyone")
    token_version: Mapped[int] = mapped_column(Integer, default=1)
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Group(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "groups"

    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(30), default="team")
    parent_group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("groups.id"))


class GroupMember(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "group_members"
    __table_args__ = (UniqueConstraint("group_id", "user_id"),)

    group_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20), default="member")  # member | lead


class RoleAssignment(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Role + scope (FR-1.8). A Berlin site admin gets nothing in London (TDD §12.2)."""

    __tablename__ = "role_assignments"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(30))
    scope_type: Mapped[str] = mapped_column(String(20), default="org")  # org | site
    scope_id: Mapped[uuid.UUID | None] = mapped_column()


class Device(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    __tablename__ = "devices"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    platform: Mapped[str] = mapped_column(String(20))
    push_token: Mapped[str | None] = mapped_column(String(500))
    app_version: Mapped[str | None] = mapped_column(String(50))
    locale: Mapped[str | None] = mapped_column(String(10))
    timezone: Mapped[str | None] = mapped_column(String(64))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefreshToken(Base, PKMixin, TimestampMixin, OrgScopedMixin):
    """Rotating, with reuse detection: a replayed token revokes the whole family."""

    __tablename__ = "refresh_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    family_id: Mapped[uuid.UUID] = mapped_column()
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
