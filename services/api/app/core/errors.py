"""RFC 9457 problem+json, extended with machine-readable violations (TDD §11).

`detail` is developer-facing English. Clients render from `code` + `params` only,
which is what keeps FR-6.9 (explainable refusals) and FR-10.4 (localization) compatible.
"""

from typing import Any, Literal

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

Severity = Literal["block", "warn"]


class Violation(BaseModel):
    code: str
    params: dict[str, Any] = {}
    severity: Severity = "block"


class ProblemError(Exception):
    status: int = 400
    type_slug: str = "about:blank"
    title: str = "Request failed"

    def __init__(
        self,
        detail: str = "",
        *,
        violations: list[Violation] | None = None,
        status: int | None = None,
        title: str | None = None,
        type_slug: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.detail = detail
        self.violations = violations or []
        if status is not None:
            self.status = status
        if title is not None:
            self.title = title
        if type_slug is not None:
            self.type_slug = type_slug
        self.headers = headers or {}


class NotFound(ProblemError):
    status, type_slug, title = 404, "not-found", "Not found"


class Unauthorized(ProblemError):
    status, type_slug, title = 401, "unauthorized", "Authentication required"


class Forbidden(ProblemError):
    status, type_slug, title = 403, "forbidden", "Not permitted"


class PolicyViolation(ProblemError):
    status, type_slug, title = 422, "policy-violation", "Booking not permitted"


class ResourceUnavailable(ProblemError):
    """Raised when the exclusion constraint arbitrates against us (TDD §6.4, §10.2)."""

    status, type_slug, title = 409, "resource-unavailable", "Resource is no longer available"


async def problem_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ProblemError)
    base = str(request.base_url).rstrip("/")
    body = {
        "type": f"{base}/errors/{exc.type_slug}",
        "title": exc.title,
        "status": exc.status,
        "detail": exc.detail,
        "trace_id": request.headers.get("x-request-id", ""),
    }
    if exc.violations:
        body["violations"] = [v.model_dump() for v in exc.violations]
    return JSONResponse(
        body, status_code=exc.status, media_type="application/problem+json", headers=exc.headers
    )
