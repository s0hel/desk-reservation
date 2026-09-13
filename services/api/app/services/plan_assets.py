"""Floor plan ingest: upload an image or a PDF, get back dimensions (TDD §14.3).

Dimensions are the whole point. Desk positions are stored normalized to [0,1]
(TDD §14.2), so the only thing the rest of the system needs from a plan file is its
intrinsic aspect ratio — which is also why re-uploading a better scan of the same floor
does not move a single desk.

A PDF is rasterized here rather than in the browser: a facilities team's plan is a PDF
far more often than not, and pushing PDF rendering into the client would mean shipping a
renderer to every admin and still having no server-side dimensions to trust.
"""

from __future__ import annotations

import hashlib
import io
import uuid
from dataclasses import dataclass

import pypdfium2
from PIL import Image, UnidentifiedImageError

from app.core.config import get_settings
from app.core.errors import ProblemError, Violation

# Pillow refuses images above this many pixels as a decompression-bomb guard. The
# default (~178M px) is generous for our purposes but we set it explicitly so the limit
# is a decision rather than a default that could change under us.
Image.MAX_IMAGE_PIXELS = 120_000_000

RASTER_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}
PDF_TYPE = "application/pdf"
ACCEPTED = set(RASTER_TYPES) | {PDF_TYPE}


class UnsupportedPlan(ProblemError):
    status, type_slug, title = 415, "unsupported-plan", "Unsupported floor plan file"


class PlanTooLarge(ProblemError):
    status, type_slug, title = 413, "plan-too-large", "Floor plan file is too large"


@dataclass(frozen=True)
class RenderedPlan:
    """What ingest produced: the bytes to store, their type, and the true dimensions."""

    data: bytes
    content_type: str
    extension: str
    width_px: int
    height_px: int
    checksum: str
    #: True when the stored bytes are not the bytes that were uploaded (PDF, or an
    #: oversized raster that was downscaled). Recorded so the console can say so.
    converted: bool


def _fingerprint(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _render_pdf(data: bytes) -> tuple[bytes, int, int]:
    settings = get_settings()
    try:
        document = pypdfium2.PdfDocument(data)
    except pypdfium2.PdfiumError as exc:
        raise UnsupportedPlan(
            "The PDF could not be opened",
            violations=[Violation(code="plan.pdf_unreadable")],
        ) from exc
    try:
        if len(document) == 0:
            raise UnsupportedPlan(
                "The PDF has no pages",
                violations=[Violation(code="plan.pdf_empty")],
            )
        # Page 1 only: a floor plan is one page, and silently picking a page out of a
        # multi-page set would be a guess the admin should make instead.
        page = document[0]
        # pypdfium2 scales by a factor against 72dpi rather than by target width.
        point_width = page.get_width() or 612
        scale = max(0.2, min(8.0, settings.plan_pdf_render_width_px / point_width))
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
    finally:
        document.close()

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), image.width, image.height


def _downscale(image: Image.Image, max_edge: int) -> Image.Image:
    longest = max(image.width, image.height)
    if longest <= max_edge:
        return image
    ratio = max_edge / longest
    return image.resize(
        (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
        Image.LANCZOS,
    )


def ingest(data: bytes, content_type: str, filename: str | None = None) -> RenderedPlan:
    """Validate and normalize an uploaded plan. Raises ProblemError for bad input."""
    settings = get_settings()

    if len(data) > settings.max_plan_upload_bytes:
        raise PlanTooLarge(
            f"Plan exceeds {settings.max_plan_upload_bytes} bytes",
            violations=[
                Violation(
                    code="plan.too_large",
                    params={"max_bytes": settings.max_plan_upload_bytes, "bytes": len(data)},
                )
            ],
        )
    if not data:
        raise UnsupportedPlan("Empty upload", violations=[Violation(code="plan.empty")])

    # The declared type is a hint. What matters is what the bytes actually are, which is
    # why every branch below decodes rather than trusting the header.
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared not in ACCEPTED:
        raise UnsupportedPlan(
            f"Unsupported content type {declared!r}",
            violations=[
                Violation(
                    code="plan.unsupported_type",
                    params={"content_type": declared, "accepted": sorted(ACCEPTED)},
                )
            ],
        )

    if declared == PDF_TYPE:
        rendered, width, height = _render_pdf(data)
        return RenderedPlan(
            data=rendered,
            content_type="image/png",
            extension="png",
            width_px=width,
            height_px=height,
            checksum=_fingerprint(data),
            converted=True,
        )

    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            image = opened.convert("RGB") if opened.mode not in ("RGB", "RGBA") else opened.copy()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise UnsupportedPlan(
            "The image could not be decoded",
            violations=[Violation(code="plan.image_unreadable")],
        ) from exc

    resized = _downscale(image, settings.plan_max_edge_px)
    if resized is image:
        return RenderedPlan(
            data=data,
            content_type=declared,
            extension=RASTER_TYPES[declared],
            width_px=image.width,
            height_px=image.height,
            checksum=_fingerprint(data),
            converted=False,
        )

    buffer = io.BytesIO()
    resized.convert("RGB").save(buffer, format="PNG", optimize=True)
    return RenderedPlan(
        data=buffer.getvalue(),
        content_type="image/png",
        extension="png",
        width_px=resized.width,
        height_px=resized.height,
        checksum=_fingerprint(data),
        converted=True,
    )


def storage_key(org_id: uuid.UUID, asset_id: uuid.UUID, extension: str) -> str:
    return f"plans/{org_id}/{asset_id}.{extension}"
