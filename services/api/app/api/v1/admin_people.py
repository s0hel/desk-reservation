"""User, group and role administration for the console (FR-8.4).

A separate module from `admin.py` because it is a separate job: that one edits the
building, this one edits the directory. They share a prefix and the admin role gate,
and `router.py` mounts both.

One route here is gated harder than the rest. Role assignment requires `org_admin`,
not merely an admin role, because a site admin who can grant roles can grant themselves
`org_admin` — which is not delegation, it is the absence of a permission boundary.

**No handler here calls `session.commit()`.** The `db` dependency commits once the
handler has returned, and committing early is actively wrong in this module: every
write route answers with the state it just produced, and `SET LOCAL app.org_id` dies
with the transaction (TDD §18.2). Commit first and the read-back runs with no tenant
context, so RLS returns nothing and the route 404s on the row it has just written.
That is not a hypothetical — it is what these routes did until a group could not be
joined through the console.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, db, require_role
from app.models import Group, GroupMember, User
from app.services import people as people_service

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_role("site_admin", "org_admin"))],
)


# ------------------------------------------------------------------------ schemas


class RoleOut(BaseModel):
    role: str
    scope_type: str
    scope_id: uuid.UUID | None


class GroupRefOut(BaseModel):
    id: uuid.UUID
    name: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    locale: str
    status: str
    home_site_id: uuid.UUID | None
    presence_visibility: str
    is_active: bool
    roles: list[RoleOut]
    groups: list[GroupRefOut]


class UserPageOut(BaseModel):
    """A page of the directory.

    `total` is the count of everyone matching the filter, not the length of `users` —
    a console that cannot say "showing 50 of 480" makes an admin guess whether the
    person they are looking for is simply further down.
    """

    total: int
    users: list[UserOut]


class UserIn(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=1, max_length=200)
    home_site_id: uuid.UUID | None = None
    locale: str = Field(default="en", max_length=10)


class UserPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    home_site_id: uuid.UUID | None = None
    locale: str | None = Field(default=None, max_length=10)


class RolesIn(BaseModel):
    roles: list[RoleOut]


class DeactivationOut(BaseModel):
    bookings: int
    sample: list[str]
    groups: int
    #: True when this is the only administrator left, in which case the POST refuses.
    #: Reported by the preview so the console can say so before the admin commits.
    is_last_admin: bool


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = Field(default="team", max_length=30)


class GroupZoneOut(BaseModel):
    id: uuid.UUID
    name: str
    mode: str


class GroupOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    member_count: int
    #: Zones whose access depends on this group. Non-empty means it cannot be deleted.
    zones: list[GroupZoneOut]


class MemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: str
    role: str
    is_active: bool


class MemberIn(BaseModel):
    user_id: uuid.UUID
    role: str = Field(default="member", max_length=20)


# ----------------------------------------------------------------------- shaping


def _user_out(
    user: User,
    roles: dict[uuid.UUID, list],
    groups: dict[uuid.UUID, list[Group]],
) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        locale=user.locale,
        status=user.status,
        home_site_id=user.home_site_id,
        presence_visibility=user.presence_visibility,
        is_active=user.deactivated_at is None and user.status == "active",
        roles=[
            RoleOut(role=r.role, scope_type=r.scope_type, scope_id=r.scope_id)
            for r in roles.get(user.id, [])
        ],
        groups=[GroupRefOut(id=g.id, name=g.name) for g in groups.get(user.id, [])],
    )


async def _one_user_out(session: AsyncSession, user: User) -> UserOut:
    return _user_out(
        user,
        await people_service.roles_of(session, [user.id]),
        await people_service.groups_of(session, [user.id]),
    )


# ------------------------------------------------------------------------- users


@router.get("/users", response_model=UserPageOut)
async def list_users(
    session: Annotated[AsyncSession, Depends(db)],
    q: Annotated[str | None, Query(max_length=200)] = None,
    group_id: Annotated[uuid.UUID | None, Query(alias="group")] = None,
    include_inactive: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> UserPageOut:
    """The directory (FR-8.4).

    Deactivated people are hidden by default and findable on request: they still hold
    history, and an admin looking for "did we ever have a Dana" needs to find her.
    """
    filters = []
    if not include_inactive:
        filters.append(User.deactivated_at.is_(None))
    if q:
        term = f"%{q.strip().lower()}%"
        filters.append(
            or_(func.lower(User.display_name).like(term), func.lower(User.email).like(term))
        )
    if group_id is not None:
        filters.append(
            User.id.in_(select(GroupMember.user_id).where(GroupMember.group_id == group_id))
        )

    total = await session.scalar(select(func.count()).select_from(User).where(*filters)) or 0
    rows = list(
        await session.scalars(
            select(User).where(*filters).order_by(User.display_name).limit(limit).offset(offset)
        )
    )
    ids = [u.id for u in rows]
    roles = await people_service.roles_of(session, ids)
    groups = await people_service.groups_of(session, ids)
    return UserPageOut(total=total, users=[_user_out(u, roles, groups) for u in rows])


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(
    body: UserIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> UserOut:
    user = await people_service.create_user(
        session,
        organization_id=actor.organization_id,
        email=str(body.email),
        display_name=body.display_name,
        home_site_id=body.home_site_id,
        locale=body.locale,
    )
    return await _one_user_out(session, user)


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> UserOut:
    return await _one_user_out(session, await people_service.user_or_404(session, user_id))


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    body: UserPatch,
    session: Annotated[AsyncSession, Depends(db)],
) -> UserOut:
    user = await people_service.user_or_404(session, user_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await session.flush()
    return await _one_user_out(session, user)


@router.get("/users/{user_id}/deactivation", response_model=DeactivationOut)
async def preview_deactivation(
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> DeactivationOut:
    """What deactivating this person would release, before it happens.

    The third preview of this shape in the console — floor-plan publish, blackout, this
    — and they exist for one reason: every destructive admin action in this product
    tells you its cost while you can still decline to pay it.
    """
    user = await people_service.user_or_404(session, user_id)
    impact = await people_service.deactivation_impact(session, user)
    return DeactivationOut(**vars(impact))


@router.post("/users/{user_id}/deactivation", response_model=UserOut)
async def deactivate_user(
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> UserOut:
    user = await people_service.user_or_404(session, user_id)
    await people_service.deactivate(session, actor=actor, user=user)
    return await _one_user_out(session, user)


@router.delete("/users/{user_id}/deactivation", response_model=UserOut)
async def reactivate_user(
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> UserOut:
    user = await people_service.user_or_404(session, user_id)
    await people_service.reactivate(session, user)
    return await _one_user_out(session, user)


@router.put(
    "/users/{user_id}/roles",
    response_model=UserOut,
    dependencies=[Depends(require_role("org_admin"))],
)
async def set_roles(
    user_id: uuid.UUID,
    body: RolesIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> UserOut:
    """Replace someone's roles (FR-1.8). `org_admin` only — see the module docstring."""
    user = await people_service.user_or_404(session, user_id)
    await people_service.set_roles(
        session,
        actor=actor,
        user=user,
        assignments=[(r.role, r.scope_type, r.scope_id) for r in body.roles],
    )
    return await _one_user_out(session, user)


# ------------------------------------------------------------------------ groups


async def _group_out(session: AsyncSession, group: Group) -> GroupOut:
    members = await session.scalar(
        select(func.count()).select_from(GroupMember).where(GroupMember.group_id == group.id)
    )
    gated = await people_service.zones_gated_by(session, group.id)
    return GroupOut(
        id=group.id,
        name=group.name,
        kind=group.kind,
        member_count=members or 0,
        zones=[GroupZoneOut(id=z.id, name=z.name, mode=mode) for z, mode in gated],
    )


@router.get("/groups", response_model=list[GroupOut])
async def list_groups(session: Annotated[AsyncSession, Depends(db)]) -> list[GroupOut]:
    """Every group, with what depends on it.

    The counts come from two aggregate queries rather than two per group: the zone list
    is not decoration, it is what the delete button reads to decide whether it can be
    offered at all, so it has to be on the list view and it has to be cheap.
    """
    groups = list(await session.scalars(select(Group).order_by(Group.name)))
    counts = await people_service.member_counts(session)
    gating = await people_service.zone_gating(session)
    return [
        GroupOut(
            id=g.id,
            name=g.name,
            kind=g.kind,
            member_count=counts.get(g.id, 0),
            zones=[
                GroupZoneOut(id=z.id, name=z.name, mode=mode) for z, mode in gating.get(g.id, [])
            ],
        )
        for g in groups
    ]


@router.post("/groups", response_model=GroupOut, status_code=201)
async def create_group(
    body: GroupIn,
    session: Annotated[AsyncSession, Depends(db)],
    actor: Annotated[User, Depends(current_user)],
) -> GroupOut:
    group = await people_service.create_group(
        session, organization_id=actor.organization_id, name=body.name, kind=body.kind
    )
    return await _group_out(session, group)


@router.patch("/groups/{group_id}", response_model=GroupOut)
async def rename_group(
    group_id: uuid.UUID,
    body: GroupIn,
    session: Annotated[AsyncSession, Depends(db)],
) -> GroupOut:
    group = await people_service.group_or_404(session, group_id)
    group.name = body.name.strip()
    group.kind = body.kind
    await session.flush()
    return await _group_out(session, group)


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> Response:
    """Refused while a zone's access depends on it — see `people.delete_group`."""
    group = await people_service.group_or_404(session, group_id)
    await people_service.delete_group(session, group)
    return Response(status_code=204)


@router.get("/groups/{group_id}/members", response_model=list[MemberOut])
async def list_members(
    group_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> list[MemberOut]:
    await people_service.group_or_404(session, group_id)
    rows = await session.execute(
        select(User, GroupMember.role)
        .join(GroupMember, GroupMember.user_id == User.id)
        .where(GroupMember.group_id == group_id)
        .order_by(User.display_name)
    )
    return [
        MemberOut(
            user_id=user.id,
            display_name=user.display_name,
            email=user.email,
            role=role,
            is_active=user.deactivated_at is None and user.status == "active",
        )
        for user, role in rows
    ]


@router.post("/groups/{group_id}/members", response_model=list[MemberOut])
async def add_member(
    group_id: uuid.UUID,
    body: MemberIn,
    session: Annotated[AsyncSession, Depends(db)],
) -> list[MemberOut]:
    group = await people_service.group_or_404(session, group_id)
    user = await people_service.user_or_404(session, body.user_id)
    await people_service.add_member(session, group=group, user=user, role=body.role)
    return await list_members(group_id, session)


@router.delete("/groups/{group_id}/members/{user_id}", response_model=list[MemberOut])
async def remove_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
) -> list[MemberOut]:
    await people_service.group_or_404(session, group_id)
    await people_service.remove_member(session, group_id=group_id, user_id=user_id)
    return await list_members(group_id, session)
