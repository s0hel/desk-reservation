"""The building photo, and the home office it belongs to (FR-1.9, FR-2.1).

Three things here are quiet when they break:

- a photo URL that works across tenants, because the capability travels in the URL
  rather than in an Authorization header (see `api/v1/plans.py`),
- `home_site_id` pointed at another tenant's site, which the foreign key happily
  accepts and every RLS-scoped read then treats as absent,
- an upload whose row commits but whose blob was never written, leaving a header that
  404s for everyone.
"""

import io
import uuid

import pytest
from PIL import Image
from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import Unauthorized
from app.core.ids import uuid7
from app.core.security import (
    PLAN_AUDIENCE,
    SITE_PHOTO_AUDIENCE,
    sign_asset_url,
    verify_asset_token,
)
from app.core.time import now_utc
from app.db.session import SessionFactory, _apply_tenant
from app.models import Organization, OrgDomain, RoleAssignment, Site, SitePhoto, User
from app.services import site_photos
from app.services.site_photos import PhotoTooLarge, UnsupportedPhoto
from app.services.storage import LocalBlobStore, StorageError


def jpeg_bytes(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "slategray").save(buffer, format="JPEG")
    return buffer.getvalue()


def png_bytes(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return buffer.getvalue()


# ------------------------------------------------------------------------- ingest


def test_a_photo_is_always_re_encoded_to_jpeg():
    """Unlike a plan, which keeps its own bytes when it is already small enough.

    The re-encode is what strips EXIF — including the GPS tag on a photo taken
    standing outside the building — so it has to happen even for a small PNG that
    needed no resizing.
    """
    result = site_photos.ingest(png_bytes(800, 600), "image/png")
    assert result.content_type == "image/jpeg"
    assert result.extension == "jpg"
    with Image.open(io.BytesIO(result.data)) as image:
        assert image.format == "JPEG"


def test_an_oversized_photo_is_downscaled_and_keeps_its_aspect_ratio():
    settings = get_settings()
    long_edge = settings.site_photo_max_edge_px * 3
    result = site_photos.ingest(jpeg_bytes(long_edge, long_edge // 2), "image/jpeg")
    assert max(result.width_px, result.height_px) == settings.site_photo_max_edge_px
    assert result.width_px / result.height_px == pytest.approx(2.0, abs=0.01)


def test_the_ceiling_is_tighter_than_a_floor_plans():
    """A hero image downloaded on app open is not a document. If these ever converge,
    the comment in `services/site_photos.py` explaining why they are separate is wrong.
    """
    settings = get_settings()
    assert settings.site_photo_max_edge_px < settings.plan_max_edge_px
    assert settings.max_site_photo_upload_bytes < settings.max_plan_upload_bytes


def test_a_pdf_is_refused_rather_than_rasterized():
    """The plan pipeline accepts one. A PDF here means someone uploaded the lease."""
    with pytest.raises(UnsupportedPhoto) as exc:
        site_photos.ingest(b"%PDF-1.4 ...", "application/pdf")
    assert exc.value.violations[0].params["content_type"] == "application/pdf"


def test_a_declared_type_is_not_trusted():
    with pytest.raises(UnsupportedPhoto) as exc:
        site_photos.ingest(b"this is not an image", "image/jpeg")
    assert exc.value.violations[0].code == "photo.image_unreadable"


def test_oversized_upload_is_refused_before_decoding():
    settings = get_settings()
    with pytest.raises(PhotoTooLarge):
        site_photos.ingest(b"\x00" * (settings.max_site_photo_upload_bytes + 1), "image/jpeg")


def test_checksum_is_of_the_upload_not_the_render():
    """So re-uploading an unchanged file is recognisable even after the encoder's
    quality setting changes."""
    source = jpeg_bytes(400, 300)
    assert (
        site_photos.ingest(source, "image/jpeg").checksum
        == site_photos.ingest(source, "image/jpeg").checksum
    )


# -------------------------------------------------------------- keys and capabilities


def test_photo_keys_are_org_prefixed_and_accepted_by_the_store(tmp_path):
    org, asset = uuid.uuid4(), uuid.uuid4()
    key = site_photos.storage_key(org, asset, "jpg")
    assert key == f"photos/{org}/{asset}.jpg"

    store = LocalBlobStore(tmp_path)
    store.put(key, b"bytes")
    assert store.get(key) == b"bytes"


def test_the_store_still_refuses_a_key_outside_the_closed_prefix_set(tmp_path):
    """Widening the pattern for `photos/` must not have widened it to anything."""
    store = LocalBlobStore(tmp_path)
    with pytest.raises(StorageError):
        store.put(f"uploads/{uuid.uuid4()}/{uuid.uuid4()}.jpg", b"x")


def test_a_plan_token_cannot_address_a_site_photo():
    """The two endpoints look assets up in different tables, so a mix-up would 404
    anyway — but a token that only works for what it was issued for is one fewer thing
    to reason about."""
    asset, org = uuid.uuid4(), uuid.uuid4()
    plan_token = sign_asset_url(asset, org, audience=PLAN_AUDIENCE)
    with pytest.raises(Unauthorized):
        verify_asset_token(plan_token, audience=SITE_PHOTO_AUDIENCE)

    photo_token = sign_asset_url(asset, org, audience=SITE_PHOTO_AUDIENCE)
    assert verify_asset_token(photo_token, audience=SITE_PHOTO_AUDIENCE) == (asset, org)


def test_the_default_audience_is_still_the_plan_one():
    """`sign_asset_url` gained a parameter; every existing caller passes none."""
    asset, org = uuid.uuid4(), uuid.uuid4()
    assert verify_asset_token(sign_asset_url(asset, org)) == (asset, org)


# ------------------------------------------------------- through the HTTP layer


class World:
    org: uuid.UUID
    site: uuid.UUID
    other_org: uuid.UUID
    other_site: uuid.UUID
    boss_email: str
    priya_email: str


@pytest.fixture
async def world() -> World:
    w = World()
    w.org, w.other_org = uuid.uuid4(), uuid.uuid4()

    for org, slug, admin in ((w.org, "photo-a", True), (w.other_org, "photo-b", False)):
        async with SessionFactory() as s:
            await s.begin()
            await _apply_tenant(s, org)
            s.add(Organization(id=org, name=slug, slug=f"{slug}-{org.hex[:8]}"))
            await s.flush()
            s.add(
                OrgDomain(
                    id=uuid7(),
                    organization_id=org,
                    domain=f"{org.hex[:8]}.example",
                    created_at=now_utc(),
                    updated_at=now_utc(),
                )
            )
            site = Site(
                id=uuid7(),
                organization_id=org,
                name="Tampa — Rocky Point",
                short_name="Tampa",
                timezone="America/New_York",
                opening_hours={d: ["07:00", "19:00"] for d in ("mon", "tue", "wed", "thu", "fri")},
            )
            s.add(site)
            await s.flush()
            if admin:
                w.site = site.id
                for attr, name, role in (
                    ("boss_email", "Ada Boss", "org_admin"),
                    ("priya_email", "Priya Raman", "employee"),
                ):
                    u = User(
                        id=uuid7(),
                        organization_id=org,
                        email=f"{name.split()[0].lower()}@{org.hex[:8]}.example",
                        display_name=name,
                    )
                    s.add(u)
                    await s.flush()
                    s.add(
                        RoleAssignment(
                            id=uuid7(),
                            organization_id=org,
                            user_id=u.id,
                            role=role,
                            scope_type="org",
                        )
                    )
                    setattr(w, attr, u.email)
            else:
                w.other_site = site.id
            await s.commit()
    return w


@pytest.fixture
async def client():
    import httpx
    from httpx import ASGITransport

    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _headers(client, email: str) -> dict[str, str]:
    response = await client.post("/v1/auth/dev-login", json={"email": email})
    assert response.status_code == 200, response.text
    return {"authorization": f"Bearer {response.json()['access_token']}"}


async def test_upload_publishes_the_photo_and_the_image_is_actually_fetchable(
    world, client, tmp_path, monkeypatch
):
    """The whole round trip, because the two halves fail independently: a row that
    points at a blob nobody wrote serves a 404 header, and a blob with no row is
    invisible."""
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path))
    headers = await _headers(client, world.boss_email)

    uploaded = await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=headers,
        files={"file": ("hq.jpg", jpeg_bytes(2000, 1000), "image/jpeg")},
    )
    assert uploaded.status_code == 201, uploaded.text
    photo = uploaded.json()["photo"]
    assert photo["aspect_ratio"] == pytest.approx(2.0, abs=0.01)

    # The URL is absolute and signed; the test client only serves paths.
    path = photo["url"].split("/v1/", 1)[1]
    fetched = await client.get(f"/v1/{path}")
    assert fetched.status_code == 200, fetched.text
    assert fetched.headers["content-type"] == "image/jpeg"
    with Image.open(io.BytesIO(fetched.content)) as image:
        assert image.size == (photo["width_px"], photo["height_px"])


async def test_the_photo_reaches_an_ordinary_employee_on_the_sites_list(
    world, client, tmp_path, monkeypatch
):
    """The home screen reads `/v1/sites`, not the admin routes."""
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path))
    admin = await _headers(client, world.boss_email)
    await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=admin,
        files={"file": ("hq.jpg", jpeg_bytes(1200, 800), "image/jpeg")},
    )

    employee = await _headers(client, world.priya_email)
    sites = await client.get("/v1/sites", headers=employee)
    assert sites.status_code == 200, sites.text
    site = sites.json()[0]
    assert site["short_name"] == "Tampa", "the greeting needs the place, not the filing name"
    assert site["photo"]["url"].startswith("http")


async def test_a_photo_token_for_one_tenant_cannot_read_another_tenants_photo(
    world, client, tmp_path, monkeypatch
):
    """The capability is in the URL, so this is the only thing standing between the two
    tenants. The serving endpoint takes the org FROM THE TOKEN and the lookup then runs
    under RLS — so a token minted for org B addressing org A's asset id finds nothing.
    """
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path))
    headers = await _headers(client, world.boss_email)
    uploaded = await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=headers,
        files={"file": ("hq.jpg", jpeg_bytes(600, 400), "image/jpeg")},
    )
    asset_id = uuid.UUID(uploaded.json()["photo"]["url"].split("/site-photos/")[1].split("?")[0])

    forged = sign_asset_url(asset_id, world.other_org, audience=SITE_PHOTO_AUDIENCE)
    response = await client.get(f"/v1/site-photos/{asset_id}?t={forged}")
    assert response.status_code == 404, response.text


async def test_deleting_the_photo_leaves_the_site_and_clears_the_header(
    world, client, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path))
    headers = await _headers(client, world.boss_email)
    await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=headers,
        files={"file": ("hq.jpg", jpeg_bytes(600, 400), "image/jpeg")},
    )
    removed = await client.delete(f"/v1/admin/sites/{world.site}/photo", headers=headers)
    assert removed.status_code == 200, removed.text
    assert removed.json()["photo"] is None
    assert removed.json()["short_name"] == "Tampa"


async def test_replacing_a_photo_keeps_the_old_blob_readable(world, client, tmp_path, monkeypatch):
    """A phone part-way through fetching the old URL must not get a 404 because an
    admin picked a better picture while it was downloading."""
    monkeypatch.setattr(get_settings(), "storage_dir", str(tmp_path))
    headers = await _headers(client, world.boss_email)
    first = await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=headers,
        files={"file": ("old.jpg", jpeg_bytes(600, 400), "image/jpeg")},
    )
    old_path = first.json()["photo"]["url"].split("/v1/", 1)[1]

    second = await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=headers,
        files={"file": ("new.jpg", jpeg_bytes(900, 300), "image/jpeg")},
    )
    assert second.json()["photo"]["url"] != first.json()["photo"]["url"]
    assert (await client.get(f"/v1/{old_path}")).status_code == 200


async def test_an_employee_cannot_upload_a_photo(world, client):
    employee = await _headers(client, world.priya_email)
    response = await client.post(
        f"/v1/admin/sites/{world.site}/photo",
        headers=employee,
        files={"file": ("hq.jpg", jpeg_bytes(400, 300), "image/jpeg")},
    )
    assert response.status_code == 403, response.text


# ----------------------------------------------------------------- the home office


async def test_a_user_can_set_their_own_home_site(world, client):
    headers = await _headers(client, world.priya_email)
    assert (await client.get("/v1/me", headers=headers)).json()["home_site_id"] is None

    updated = await client.patch("/v1/me", headers=headers, json={"home_site_id": str(world.site)})
    assert updated.status_code == 200, updated.text
    assert updated.json()["home_site_id"] == str(world.site)


async def test_home_site_cannot_be_set_to_another_tenants_site(world, client):
    """The foreign key will not catch this. Postgres runs FK checks as the referencing
    table's owner and they are not subject to RLS, so the constraint accepts another
    tenant's site id and every RLS-scoped read afterwards treats the home office as
    absent — an account that opens on nothing, with nothing logged.
    """
    headers = await _headers(client, world.priya_email)
    response = await client.patch(
        "/v1/me", headers=headers, json={"home_site_id": str(world.other_site)}
    )
    assert response.status_code == 404, response.text

    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, world.org)
        user = await s.scalar(select(User).where(User.email == world.priya_email))
        assert user.home_site_id is None, "the refused write must not have landed"


async def test_home_site_can_be_cleared(world, client):
    """Null is a legitimate value: it is what sends a new joiner to the first-run
    picker, and what an admin sets when someone leaves a site."""
    headers = await _headers(client, world.priya_email)
    await client.patch("/v1/me", headers=headers, json={"home_site_id": str(world.site)})
    cleared = await client.patch("/v1/me", headers=headers, json={"home_site_id": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["home_site_id"] is None


async def test_an_unset_short_name_is_null_rather_than_guessed(world, client, session_for):
    """The client falls back to `name`. The server must not strip suffixes to invent a
    place — that is how you greet somebody with "Welcome to Tampa — Rocky Poin"."""
    async with session_for(world.org) as s:
        site = await s.scalar(select(Site).where(Site.id == world.site))
        site.short_name = None

    headers = await _headers(client, world.priya_email)
    site = (await client.get("/v1/sites", headers=headers)).json()[0]
    assert site["short_name"] is None
    assert site["name"] == "Tampa — Rocky Point"


async def test_a_site_row_with_a_dangling_photo_id_renders_as_no_photo(world, session_for):
    """Rather than raising. The header is decoration; a missing asset row must not take
    the home screen down with it."""
    from app.api.v1.spaces import site_out

    async with session_for(world.org) as s:
        site = await s.scalar(select(Site).where(Site.id == world.site))
        orphan = SitePhoto(
            id=uuid7(),
            organization_id=world.org,
            storage_key="photos/x/y.jpg",
            width_px=1,
            height_px=1,
            content_type="image/jpeg",
        )
        s.add(orphan)
        await s.flush()
        site.photo_asset_id = orphan.id
        await s.flush()
        await s.delete(orphan)
        await s.flush()

        assert (await site_out(s, site)).photo is None
