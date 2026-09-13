"""Floor plan ingest and signed plan URLs (TDD §14.3, §11).

Dimensions are what the rest of the system consumes — positions are normalized against
them (TDD §14.2) — so getting them wrong silently moves every desk on the floor.
"""

import io
import uuid

import pypdfium2
import pytest
from PIL import Image

from app.core.config import get_settings
from app.core.errors import Unauthorized
from app.core.security import sign_asset_url, verify_asset_token
from app.services import plan_assets
from app.services.plan_assets import PlanTooLarge, UnsupportedPlan
from app.services.storage import LocalBlobStore, StorageError


def png_bytes(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def pdf_bytes(width_pt: float = 842, height_pt: float = 595) -> bytes:
    document = pypdfium2.PdfDocument.new()
    document.new_page(width_pt, height_pt)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_png_keeps_its_own_bytes_and_dimensions():
    data = png_bytes(2400, 1600)
    result = plan_assets.ingest(data, "image/png")
    assert (result.width_px, result.height_px) == (2400, 1600)
    assert result.converted is False
    assert result.data == data, "an in-range image should not be re-encoded"


def test_oversized_image_is_downscaled_but_keeps_its_aspect_ratio():
    """Positions are normalized, so downscaling must not change what they mean."""
    settings = get_settings()
    long_edge = settings.plan_max_edge_px * 2
    result = plan_assets.ingest(png_bytes(long_edge, long_edge // 2), "image/png")
    assert max(result.width_px, result.height_px) == settings.plan_max_edge_px
    assert result.width_px / result.height_px == pytest.approx(2.0, abs=0.01)
    assert result.converted is True


def test_pdf_is_rasterized_to_png_at_the_page_aspect_ratio():
    """A facilities team's plan is a PDF more often than not, and the server has to be
    the thing that knows its dimensions."""
    result = plan_assets.ingest(pdf_bytes(842, 595), "application/pdf")
    assert result.content_type == "image/png"
    assert result.extension == "png"
    assert result.converted is True
    assert result.width_px / result.height_px == pytest.approx(842 / 595, abs=0.01)
    # ...and the bytes really are a PNG, not a PDF with a new label.
    with Image.open(io.BytesIO(result.data)) as image:
        assert image.format == "PNG"


def test_checksum_is_of_the_upload_not_the_render():
    """Two uploads of the same source file must fingerprint the same, whatever the
    renderer does — otherwise re-uploading an unchanged plan looks like a change."""
    source = pdf_bytes()
    assert plan_assets.ingest(source, "application/pdf").checksum == (
        plan_assets.ingest(source, "application/pdf").checksum
    )


def test_a_declared_type_is_not_trusted():
    """The content type is a hint from the browser. Bytes that are not an image must be
    refused even when they claim to be one."""
    with pytest.raises(UnsupportedPlan) as exc:
        plan_assets.ingest(b"this is not an image", "image/png")
    assert exc.value.violations[0].code == "plan.image_unreadable"


def test_unsupported_type_is_named():
    with pytest.raises(UnsupportedPlan) as exc:
        plan_assets.ingest(b"%PDF-", "image/gif")
    assert exc.value.violations[0].params["content_type"] == "image/gif"


def test_oversized_upload_is_refused_before_decoding():
    settings = get_settings()
    with pytest.raises(PlanTooLarge):
        plan_assets.ingest(b"x" * (settings.max_plan_upload_bytes + 1), "image/png")


def test_empty_upload_is_refused():
    with pytest.raises(UnsupportedPlan) as exc:
        plan_assets.ingest(b"", "image/png")
    assert exc.value.violations[0].code == "plan.empty"


def test_broken_pdf_is_refused_rather_than_crashing():
    with pytest.raises(UnsupportedPlan) as exc:
        plan_assets.ingest(b"%PDF-1.4 truncated", "application/pdf")
    assert exc.value.violations[0].code == "plan.pdf_unreadable"


# ------------------------------------------------------------------------- storage


def test_local_store_round_trips(tmp_path):
    store = LocalBlobStore(tmp_path)
    key = plan_assets.storage_key(uuid.uuid4(), uuid.uuid4(), "png")
    payload = png_bytes(10, 10)
    store.put(key, payload)
    assert store.exists(key)
    assert store.get(key) == payload


def test_local_store_refuses_a_traversing_key(tmp_path):
    """Keys are ours, not a client's — this is a tripwire for a future caller that
    forgets that, and it should fail loudly rather than write outside the root."""
    store = LocalBlobStore(tmp_path)
    with pytest.raises(StorageError):
        store.put("plans/../../etc/passwd", b"x")


def test_local_store_writes_are_atomic(tmp_path):
    """Write-then-rename: a reader must never see a half-written plan."""
    store = LocalBlobStore(tmp_path)
    key = plan_assets.storage_key(uuid.uuid4(), uuid.uuid4(), "png")
    store.put(key, png_bytes(10, 10))
    assert list(tmp_path.rglob("*.part")) == []


# --------------------------------------------------------------------- signed URLs


def test_asset_token_carries_the_tenant():
    """The serving endpoint binds the tenant from the token, so it has to be in there —
    a query parameter would be a claim, not a capability."""
    asset_id, org_id = uuid.uuid4(), uuid.uuid4()
    assert verify_asset_token(sign_asset_url(asset_id, org_id)) == (asset_id, org_id)


def test_an_access_token_is_not_an_asset_token():
    """Different audiences. A leaked plan URL must not be usable as an API credential,
    and an access token must not be usable to enumerate plans."""
    from app.core.security import create_access_token, decode_access_token

    access = create_access_token(
        user_id=uuid.uuid4(), org_id=uuid.uuid4(), roles=["employee"], token_version=1
    )
    with pytest.raises(Unauthorized):
        verify_asset_token(access)
    with pytest.raises(Unauthorized):
        decode_access_token(sign_asset_url(uuid.uuid4(), uuid.uuid4()))


def test_a_tampered_asset_token_is_rejected():
    token = sign_asset_url(uuid.uuid4(), uuid.uuid4())
    head, payload, signature = token.split(".")
    with pytest.raises(Unauthorized):
        verify_asset_token(f"{head}.{payload}.{signature[:-2]}xx")
