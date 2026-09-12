"""OIDC relying-party helpers (TDD §12.1).

The API is the RP, not the app: multi-tenant IdP config stays server-side and no
client secret ever ships in a binary. Adding SAML later changes nothing in the app.
"""

import base64
import hashlib
import secrets
from typing import Any

import httpx
import jwt
from jwt import PyJWKClient

from app.core.errors import Unauthorized
from app.models import IdentityProvider

_discovery_cache: dict[str, dict[str, Any]] = {}


async def discover(idp: IdentityProvider) -> dict[str, Any]:
    if not idp.discovery_url:
        raise Unauthorized("Identity provider has no discovery URL configured")
    if idp.discovery_url not in _discovery_cache:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(idp.discovery_url)
            resp.raise_for_status()
            _discovery_cache[idp.discovery_url] = resp.json()
    return _discovery_cache[idp.discovery_url]


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    return verifier, challenge


def verify_challenge(verifier: str, challenge: str) -> bool:
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    return secrets.compare_digest(expected, challenge)


async def exchange_code(
    idp: IdentityProvider, meta: dict[str, Any], code: str, redirect_uri: str, verifier: str
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            meta["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": idp.client_id,
                "client_secret": idp.client_secret_enc or "",
                "code_verifier": verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        raise Unauthorized(f"Token exchange failed: {resp.text[:200]}")
    return resp.json()


def validate_id_token(idp: IdentityProvider, meta: dict[str, Any], id_token: str) -> dict[str, Any]:
    signing_key = PyJWKClient(meta["jwks_uri"]).get_signing_key_from_jwt(id_token)
    try:
        return jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=idp.client_id,
            issuer=meta["issuer"],
        )
    except jwt.PyJWTError as exc:
        raise Unauthorized(f"Invalid ID token: {exc}") from exc
