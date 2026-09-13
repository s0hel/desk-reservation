"""Resource attribute schemas, validated per `kind` (TDD §6.3, FR-2.5, FR-3.1).

`resources.attributes` is jsonb, which is what lets parking and lockers arrive later
without a migration. That flexibility is only safe if writes are validated: an admin who
types `monitor: 2` instead of `monitors: 2` would otherwise create a desk that silently
fails every attribute filter, and nothing would ever say so.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.errors import Violation


class DeskAttributes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sit_stand: bool = False
    monitors: int = Field(default=0, ge=0, le=6)
    dock: Literal["none", "usb_c", "thunderbolt", "dual"] = "none"
    window: bool = False
    quiet: bool = False
    accessible: bool = False


class RoomAttributes(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display: bool = False
    video_conf: bool = False
    whiteboard: bool = False
    phone: bool = False
    photos: list[str] = Field(default_factory=list)


SCHEMAS: dict[str, type[BaseModel]] = {"desk": DeskAttributes, "room": RoomAttributes}


def validate(kind: str, attributes: dict, *, where: str) -> tuple[dict, list[Violation]]:
    """Normalize attributes for a kind, filling defaults.

    Returns `(normalized, violations)` rather than raising, so a caller validating 300
    desks can report every bad one at once. An admin who has to fix a bulk import one
    error per round trip will give up (PRD risk R5). `where` names the offender.
    """
    schema = SCHEMAS.get(kind)
    if schema is None:
        return {}, [Violation(code="layout.unknown_kind", params={"kind": kind, "where": where})]
    try:
        return schema.model_validate(attributes or {}).model_dump(), []
    except ValidationError as exc:
        return {}, [
            Violation(
                code="layout.invalid_attributes",
                params={
                    "where": where,
                    "kind": kind,
                    "fields": sorted({str(e["loc"][0]) for e in exc.errors() if e["loc"]}),
                },
            )
        ]
