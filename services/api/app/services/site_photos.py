"""Site photo ingest: upload a picture of the building, get back dimensions.

The sibling of `plan_assets`, and deliberately not a reuse of it. A floor plan is a
document — often a PDF, rasterized server-side, kept at whatever resolution the desks
were positioned against. A building photo is decoration: it is shown once, at the top
of the home screen, at roughly 400pt wide on the largest phone we support, and the only
thing that matters about it is that it downloads fast over hotel wifi on a Monday.

So the two pipelines differ where it counts and would have to grow `if` branches to
share:

- No PDF. A facilities team's photo is a photo; accepting a PDF here would mean
  rasterizing a document into a hero image, which is never what was meant.
- Hard re-encode to JPEG. `plan_assets` keeps the uploaded bytes when they are already
  small enough, because a plan's crispness is load-bearing. A 4MB portrait straight off
  a phone is not, and re-encoding also drops the EXIF — including, on a photo taken
  outside the building, the GPS tag.
- A much smaller ceiling: `site_photo_max_edge_px`, not `plan_max_edge_px`.

Dimensions are returned for the same reason as plans: the client reserves the right
aspect ratio before the image arrives, so the header does not jump when it does.
"""

from __future__ import annotations

import hashlib
import io
import uuid
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

from app.core.config import get_settings
from app.core.errors import ProblemError, Violation

# Same decompression-bomb guard as plan ingest, set explicitly so the limit is a
# decision rather than a Pillow default that could change under us.
Image.MAX_IMAGE_PIXELS = 120_000_000

ACCEPTED = {"image/png", "image/jpeg", "image/webp"}


class UnsupportedPhoto(ProblemError):
    status, type_slug, title = 415, "unsupported-photo", "Unsupported site photo"


class PhotoTooLarge(ProblemError):
    status, type_slug, title = 413, "photo-too-large", "Site photo is too large"


@dataclass(frozen=True)
class RenderedPhoto:
    data: bytes
    content_type: str
    extension: str
    width_px: int
    height_px: int
    checksum: str


def ingest(data: bytes, content_type: str) -> RenderedPhoto:
    """Validate and normalize an uploaded photo. Raises ProblemError for bad input."""
    settings = get_settings()

    if len(data) > settings.max_site_photo_upload_bytes:
        raise PhotoTooLarge(
            f"Photo exceeds {settings.max_site_photo_upload_bytes} bytes",
            violations=[
                Violation(
                    code="photo.too_large",
                    params={
                        "max_bytes": settings.max_site_photo_upload_bytes,
                        "bytes": len(data),
                    },
                )
            ],
        )
    if not data:
        raise UnsupportedPhoto("Empty upload", violations=[Violation(code="photo.empty")])

    # The declared type is a hint; the bytes are the fact. Checked first only so an
    # obviously wrong upload gets a precise refusal rather than "could not decode".
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared not in ACCEPTED:
        raise UnsupportedPhoto(
            f"Unsupported content type {declared!r}",
            violations=[
                Violation(
                    code="photo.unsupported_type",
                    params={"content_type": declared, "accepted": sorted(ACCEPTED)},
                )
            ],
        )

    try:
        with Image.open(io.BytesIO(data)) as opened:
            opened.load()
            # Phones record orientation in EXIF rather than in the pixels. Without
            # this, a photo held sideways uploads upright and renders on its side.
            image = _apply_exif_rotation(opened).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise UnsupportedPhoto(
            "The image could not be decoded",
            violations=[Violation(code="photo.image_unreadable")],
        ) from exc

    resized = _downscale(image, settings.site_photo_max_edge_px)

    buffer = io.BytesIO()
    # Re-encoded unconditionally: this is what strips EXIF, and an image that survives
    # a round trip through Pillow is one we know renders.
    resized.save(buffer, format="JPEG", quality=82, optimize=True, progressive=True)
    rendered = buffer.getvalue()

    return RenderedPhoto(
        data=rendered,
        content_type="image/jpeg",
        extension="jpg",
        width_px=resized.width,
        height_px=resized.height,
        # The checksum is of what was uploaded, not of what we stored, so re-uploading
        # the same file is recognisable even after the encoder settings change.
        checksum=hashlib.sha256(data).hexdigest(),
    )


def _apply_exif_rotation(image: Image.Image) -> Image.Image:
    from PIL import ImageOps

    return ImageOps.exif_transpose(image) or image


def _downscale(image: Image.Image, max_edge: int) -> Image.Image:
    longest = max(image.width, image.height)
    if longest <= max_edge:
        return image
    ratio = max_edge / longest
    return image.resize(
        (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
        Image.LANCZOS,
    )


def storage_key(org_id: uuid.UUID, asset_id: uuid.UUID, extension: str) -> str:
    return f"photos/{org_id}/{asset_id}.{extension}"


def photo_url(asset_id: uuid.UUID, org_id: uuid.UUID) -> str:
    """The signed URL an <Image> tag can fetch. Mirrors `admin.plan_url`."""
    from app.core.security import SITE_PHOTO_AUDIENCE, sign_asset_url

    base = get_settings().api_base_url.rstrip("/")
    token = sign_asset_url(asset_id, org_id, audience=SITE_PHOTO_AUDIENCE)
    return f"{base}/v1/site-photos/{asset_id}?t={token}"
