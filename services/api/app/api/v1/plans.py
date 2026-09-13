"""Serving floor plan images (TDD §11 "signed CDN url", §14.3).

This is the one endpoint that is not bearer-authenticated, and the reason is concrete:
the image is rendered by an `<Image>` tag inside the mobile floor plan, which cannot
attach an Authorization header. The capability therefore travels in the URL.

The token names both the asset and its tenant, and the tenant is taken FROM THE TOKEN —
never from a query parameter and never from the asset row before it has been read under
the right tenant. A token minted for org A binds org A, so the RLS-protected lookup for
org B's asset returns nothing. Isolation is still enforced by the database, exactly as
it is everywhere else; only the way the caller proves who they are has changed.

In staging and production this endpoint is replaced by a signed CloudFront URL over the
same S3 object; the signing shape is deliberately the same so the client does not care.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import anon_db
from app.core.errors import NotFound
from app.core.security import verify_asset_token
from app.db.session import _apply_tenant
from app.models import FloorPlanAsset
from app.services.storage import StorageError, get_store

router = APIRouter(tags=["plans"])


@router.get(
    "/plans/{asset_id}",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}, "description": "The plan image"}},
)
async def get_plan(
    asset_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(anon_db)],
    t: Annotated[str, Query(description="Signed capability token from the plan URL")],
) -> Response:
    token_asset_id, org_id = verify_asset_token(t)
    if token_asset_id != asset_id:
        # The token is the authority. A mismatch means someone edited the path.
        raise NotFound("Plan not found")

    await _apply_tenant(session, org_id)
    asset = await session.scalar(select(FloorPlanAsset).where(FloorPlanAsset.id == asset_id))
    if asset is None or not asset.rendered_key:
        raise NotFound("Plan not found")

    try:
        data = get_store().get(asset.rendered_key)
    except StorageError as exc:
        raise NotFound("Plan image is missing from storage") from exc

    return Response(
        content=data,
        media_type=asset.content_type,
        headers={
            # Immutable: a new upload is a new asset id, so the URL changes when the
            # image does. The max-age is bounded by the token's own lifetime anyway.
            "Cache-Control": "private, max-age=3600, immutable",
            "ETag": f'"{asset.checksum or asset.id}"',
        },
    )
