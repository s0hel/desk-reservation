"""Access/refresh tokens (TDD §12.1).

Access token: short-lived JWT carrying tenant + roles. Refresh: opaque, rotating,
with reuse detection — a replayed refresh revokes the whole family.
"""

import hashlib
import secrets
import uuid
from datetime import timedelta
from typing import Any

import jwt

from app.core.config import get_settings
from app.core.errors import Unauthorized
from app.core.time import now_utc

ALGORITHM = "HS256"


def create_access_token(
    *, user_id: uuid.UUID, org_id: uuid.UUID, roles: list[str], token_version: int
) -> str:
    s = get_settings()
    now = now_utc()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "org_id": str(org_id),
        "roles": roles,
        "ver": token_version,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=s.access_token_ttl_seconds)).timestamp()),
        "iss": s.api_base_url,
    }
    return jwt.encode(payload, s.jwt_signing_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    s = get_settings()
    try:
        return jwt.decode(token, s.jwt_signing_key, algorithms=[ALGORITHM], issuer=s.api_base_url)
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Access token expired") from exc
    except jwt.PyJWTError as exc:
        raise Unauthorized("Invalid access token") from exc


def new_refresh_token(org_id: uuid.UUID) -> tuple[str, str]:
    """Returns (plaintext, sha256 hash). Only the hash is stored.

    The token is prefixed with its organization id so the API can bind the tenant
    (SET LOCAL app.org_id) *before* the RLS-protected lookup. Without this, refresh
    would need a global-read policy on refresh_tokens, which would weaken isolation
    for the sake of one query. The prefix is not a secret and is not trusted: it only
    selects which tenant to search, and the hash still has to match.
    """
    raw = f"{org_id.hex}.{secrets.token_urlsafe(48)}"
    return raw, hash_token(raw)


def org_from_refresh_token(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(hex=raw.split(".", 1)[0])
    except (ValueError, IndexError) as exc:
        raise Unauthorized("Malformed refresh token") from exc


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def generate_pkce_verifier() -> str:
    return secrets.token_urlsafe(64)


def sign_asset_url(asset_id: uuid.UUID, org_id: uuid.UUID) -> str:
    """Short-lived capability token for one plan image (TDD §11, §14.3).

    Plan images are fetched by an <Image> tag in the mobile renderer, which cannot
    attach an Authorization header, so the capability travels in the URL instead. The
    token names both the asset and its tenant, and the serving endpoint re-derives the
    tenant from it rather than trusting a query parameter — a token for tenant A can
    therefore never address tenant B's asset, whatever the caller claims.
    """
    s = get_settings()
    now = now_utc()
    payload = {
        "sub": str(asset_id),
        "org_id": str(org_id),
        "aud": "plan-asset",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=s.plan_url_ttl_seconds)).timestamp()),
        "iss": s.api_base_url,
    }
    return jwt.encode(payload, s.jwt_signing_key, algorithm=ALGORITHM)


def verify_asset_token(token: str) -> tuple[uuid.UUID, uuid.UUID]:
    """Returns (asset_id, org_id). Raises Unauthorized on anything unexpected."""
    s = get_settings()
    try:
        claims = jwt.decode(
            token,
            s.jwt_signing_key,
            algorithms=[ALGORITHM],
            audience="plan-asset",
            issuer=s.api_base_url,
        )
        return uuid.UUID(claims["sub"]), uuid.UUID(claims["org_id"])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise Unauthorized("Invalid or expired plan URL") from exc
