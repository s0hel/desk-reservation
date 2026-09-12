import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, func
from sqlalchemy.orm import DeclarativeBase, Mapped, declared_attr, mapped_column

from app.core.ids import uuid7


class Base(DeclarativeBase):
    pass


class PKMixin:
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class OrgScopedMixin:
    """Every tenant-scoped table carries this. RLS keys on it (TDD §18.2).

    declared_attr, not a plain mapped_column: a mixin column carrying a ForeignKey must
    build a fresh FK per subclass. Declaring the FK also gives the unit of work the
    dependency graph it needs to order inserts correctly.
    """

    @declared_attr
    def organization_id(cls) -> Mapped[uuid.UUID]:  # noqa: N805
        return mapped_column(
            ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
        )
