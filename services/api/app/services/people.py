"""People administration: users, groups, roles, and deactivation (FR-8.4).

This module exists because the product shipped controls that nothing could configure.
Zone permissions (FR-6.4) grant desks to *groups*, and until now there was no way to
create a group or put anyone in one — the only route was hand-written SQL, which is
not a feature, it is a workaround someone with a database password can perform.

Three things here are load-bearing and are the reason this is a service rather than
inline route code.

**Deactivation is four changes, and three of them are the security half.** Clearing the
desk is the visible part; the invisible parts are that the person's sessions stop
working. `deactivated_at` makes `current_user` refuse, the `token_version` bump
invalidates every access token already issued (and stops an old one working again after
a later reactivation), and revoking the refresh families stops a new access token being
minted from one. Doing only the first is a "deactivated" user who keeps working until
their token expires.

**Bookings are released through `cancel_booking`, never a bulk UPDATE.** Same rule as
blackouts, same reason: the requirement is that the desk goes back to the pool *and*
the person is told, and a status update quietly skips the second half.

**An organization must never lose its last administrator.** Nothing in this product can
put one back — there is no break-glass path, no Anthropic-side console, no support tool
— so the guard is here rather than in the UI, where it would be advice.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AdminRefusal, NotFound, Violation
from app.core.ids import uuid7
from app.core.time import now_utc
from app.models import (
    Booking,
    Group,
    GroupMember,
    RefreshToken,
    RoleAssignment,
    User,
    Zone,
    ZonePermission,
)
from app.models.booking import ACTIVE_STATUSES
from app.policy import codes
from app.services.booking import cancel_booking

#: Mirrors the CHECK constraint on `role_assignments.role` (migration 0001).
ROLES: frozenset[str] = frozenset({"employee", "team_lead", "site_admin", "org_admin"})
SCOPE_TYPES: frozenset[str] = frozenset({"org", "site"})
#: The role that can create and destroy other administrators.
SUPER_ROLE = "org_admin"


# --------------------------------------------------------------------------- reads


async def roles_of(
    session: AsyncSession, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[RoleAssignment]]:
    if not user_ids:
        return {}
    rows = await session.scalars(
        select(RoleAssignment)
        .where(RoleAssignment.user_id.in_(user_ids))
        .order_by(RoleAssignment.role)
    )
    out: dict[uuid.UUID, list[RoleAssignment]] = {}
    for row in rows:
        out.setdefault(row.user_id, []).append(row)
    return out


async def groups_of(
    session: AsyncSession, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Group]]:
    if not user_ids:
        return {}
    rows = await session.execute(
        select(GroupMember.user_id, Group)
        .join(Group, Group.id == GroupMember.group_id)
        .where(GroupMember.user_id.in_(user_ids))
        .order_by(Group.name)
    )
    out: dict[uuid.UUID, list[Group]] = {}
    for user_id, group in rows:
        out.setdefault(user_id, []).append(group)
    return out


async def user_or_404(session: AsyncSession, user_id: uuid.UUID) -> User:
    user = await session.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise NotFound("User not found")
    return user


async def group_or_404(session: AsyncSession, group_id: uuid.UUID) -> Group:
    group = await session.scalar(select(Group).where(Group.id == group_id))
    if group is None:
        raise NotFound("Group not found")
    return group


# ----------------------------------------------------------------- the admin guard


async def other_active_admins(session: AsyncSession, *, excluding: uuid.UUID) -> int:
    """How many *other* people could still administer the organization.

    Counts distinct users, because one person may hold `org_admin` at more than one
    scope and would otherwise be counted twice — turning "the last admin" into "two
    admins" and letting the guard be walked straight past.
    """
    return (
        await session.scalar(
            select(func.count(func.distinct(RoleAssignment.user_id)))
            .join(User, User.id == RoleAssignment.user_id)
            .where(
                RoleAssignment.role == SUPER_ROLE,
                RoleAssignment.user_id != excluding,
                User.deactivated_at.is_(None),
                User.status == "active",
            )
        )
        or 0
    )


def _last_admin_refusal(display_name: str) -> AdminRefusal:
    return AdminRefusal(
        "this is the organization's only administrator",
        violations=[
            Violation(
                code=codes.LAST_ORG_ADMIN,
                params={"display_name": display_name},
                severity="block",
            )
        ],
    )


async def _has_role(session: AsyncSession, user_id: uuid.UUID, role: str) -> bool:
    found = await session.scalar(
        select(RoleAssignment.id).where(
            RoleAssignment.user_id == user_id, RoleAssignment.role == role
        )
    )
    return found is not None


# --------------------------------------------------------------------------- users


async def create_user(
    session: AsyncSession,
    *,
    organization_id: uuid.UUID,
    email: str,
    display_name: str,
    home_site_id: uuid.UUID | None = None,
    locale: str = "en",
) -> User:
    """Add a person to the directory.

    The address is checked here as well as by the unique index, because an
    IntegrityError surfaces as a 500 and "that email is already in use" is an ordinary
    thing for an admin to be told, not a server fault. `email` is `citext`, so the
    database comparison is case-insensitive and this one must be too.
    """
    address = email.strip()
    clash = await session.scalar(select(User).where(func.lower(User.email) == address.lower()))
    if clash is not None:
        raise AdminRefusal(
            "a user with that email already exists",
            violations=[
                Violation(
                    code=codes.EMAIL_TAKEN,
                    params={"email": address, "display_name": clash.display_name},
                    severity="block",
                )
            ],
        )

    user = User(
        id=uuid7(),
        organization_id=organization_id,
        email=address,
        display_name=display_name.strip(),
        home_site_id=home_site_id,
        locale=locale,
    )
    session.add(user)
    await session.flush()
    # Everyone is an employee; the role list is additive on top of it (FR-1.8). Without
    # this the new user signs in with no roles at all and every route refuses them.
    session.add(
        RoleAssignment(
            id=uuid7(),
            organization_id=organization_id,
            user_id=user.id,
            role="employee",
            scope_type="org",
        )
    )
    await session.flush()
    return user


@dataclass(frozen=True)
class DeactivationImpact:
    """What deactivating this person would cost, before it is done.

    The same shape of answer as the blackout preview and the floor-plan publish
    preflight, and for the same reason: an admin should see the number of desks about
    to be handed back before they cause it, not afterwards in a support ticket.
    """

    bookings: int
    #: Desk codes, newest first, for the console to name a few of them.
    sample: list[str]
    groups: int
    is_last_admin: bool


def _future_bookings(user_id: uuid.UUID):
    """Bookings that have not finished yet.

    Deliberately expressed as "the range has not ended" rather than "on or after
    today": a user can hold desks at sites in different timezones, so there is no one
    `today` to compare against (the site-timezone rule in app/core/time.py). The end of
    the booked range is an instant, and comparing instants is always well defined.
    """
    return (
        select(Booking)
        .where(
            Booking.user_id == user_id,
            Booking.status.in_(ACTIVE_STATUSES),
            func.upper(Booking.time_range) > now_utc(),
        )
        .order_by(func.lower(Booking.time_range))
    )


async def deactivation_impact(session: AsyncSession, user: User) -> DeactivationImpact:
    from app.models import Resource  # local: only this function needs the desk codes

    rows = await session.execute(
        select(Booking, Resource.code)
        .join(Resource, Resource.id == Booking.resource_id)
        .where(Booking.id.in_(_future_bookings(user.id).with_only_columns(Booking.id)))
        .order_by(func.lower(Booking.time_range))
    )
    codes_ = [code for _, code in rows]
    group_count = await session.scalar(
        select(func.count()).select_from(GroupMember).where(GroupMember.user_id == user.id)
    )
    return DeactivationImpact(
        bookings=len(codes_),
        sample=codes_[:5],
        groups=group_count or 0,
        is_last_admin=(
            await _has_role(session, user.id, SUPER_ROLE)
            and await other_active_admins(session, excluding=user.id) == 0
        ),
    )


async def deactivate(session: AsyncSession, *, actor: User, user: User) -> DeactivationImpact:
    """Take someone out of the directory and give their desks back (FR-8.4)."""
    if await _has_role(session, user.id, SUPER_ROLE) and (
        await other_active_admins(session, excluding=user.id) == 0
    ):
        raise _last_admin_refusal(user.display_name)

    released: list[str] = []
    for booking in list(await session.scalars(_future_bookings(user.id))):
        await cancel_booking(
            session,
            actor=actor,
            booking_id=booking.id,
            reason="your account was deactivated",
        )
        released.append(str(booking.id))

    user.deactivated_at = now_utc()
    user.status = "inactive"
    # Kills every access token already in the wild, and keeps them dead if this account
    # is ever reactivated — `current_user` compares the claim against this number.
    user.token_version += 1

    for token in await session.scalars(
        select(RefreshToken).where(
            RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
        )
    ):
        token.revoked_at = now_utc()

    await session.flush()
    return DeactivationImpact(bookings=len(released), sample=[], groups=0, is_last_admin=False)


async def reactivate(session: AsyncSession, user: User) -> User:
    """Let someone back in. Their old bookings are not restored — they were cancelled,
    the people holding them were told, and those desks have very likely gone."""
    user.deactivated_at = None
    user.status = "active"
    await session.flush()
    return user


async def set_roles(
    session: AsyncSession,
    *,
    actor: User,
    user: User,
    assignments: list[tuple[str, str, uuid.UUID | None]],
) -> list[RoleAssignment]:
    """Replace someone's role assignments (FR-1.8).

    Whole-list replacement rather than add/remove, because roles are additive and
    site-scoped: what an admin is deciding is the complete set of things this person may
    do, and a diff-based API makes that set something the caller has to reconstruct
    before it can be reasoned about.
    """
    for role, scope_type, _scope_id in assignments:
        if role not in ROLES or scope_type not in SCOPE_TYPES:
            raise AdminRefusal(
                f"unknown role {role!r} or scope {scope_type!r}",
                violations=[
                    Violation(
                        code=codes.UNKNOWN_ROLE,
                        params={"role": role, "scope_type": scope_type},
                        severity="block",
                    )
                ],
            )

    keeps_admin = any(role == SUPER_ROLE for role, _, _ in assignments)
    if not keeps_admin and await _has_role(session, user.id, SUPER_ROLE):
        if await other_active_admins(session, excluding=user.id) == 0:
            raise _last_admin_refusal(user.display_name)

    for existing in await session.scalars(
        select(RoleAssignment).where(RoleAssignment.user_id == user.id)
    ):
        await session.delete(existing)
    await session.flush()

    created = [
        RoleAssignment(
            id=uuid7(),
            organization_id=user.organization_id,
            user_id=user.id,
            role=role,
            # An org-scoped role has no scope id; storing one would make two rows that
            # grant the same thing look different.
            scope_type=scope_type,
            scope_id=scope_id if scope_type == "site" else None,
        )
        for role, scope_type, scope_id in assignments
    ]
    for row in created:
        session.add(row)

    # Their next request carries the old role list until they sign in again, so the
    # token has to be retired here — otherwise a revoked admin keeps admin until their
    # access token expires on its own.
    user.token_version += 1
    await session.flush()
    return created


# -------------------------------------------------------------------------- groups


async def create_group(
    session: AsyncSession, *, organization_id: uuid.UUID, name: str, kind: str = "team"
) -> Group:
    group = Group(id=uuid7(), organization_id=organization_id, name=name.strip(), kind=kind)
    session.add(group)
    await session.flush()
    return group


async def zones_gated_by(session: AsyncSession, group_id: uuid.UUID) -> list[tuple[Zone, str]]:
    """Zones whose access depends on this group (FR-6.4)."""
    rows = await session.execute(
        select(Zone, ZonePermission.mode)
        .join(ZonePermission, ZonePermission.zone_id == Zone.id)
        .where(ZonePermission.group_id == group_id)
        .order_by(Zone.name)
    )
    return [(zone, mode) for zone, mode in rows]


async def member_counts(session: AsyncSession) -> dict[uuid.UUID, int]:
    rows = await session.execute(
        select(GroupMember.group_id, func.count()).group_by(GroupMember.group_id)
    )
    return {group_id: count for group_id, count in rows}


async def zone_gating(session: AsyncSession) -> dict[uuid.UUID, list[tuple[Zone, str]]]:
    """Every group -> the zones whose access depends on it, in one query."""
    rows = await session.execute(
        select(ZonePermission.group_id, Zone, ZonePermission.mode)
        .join(Zone, Zone.id == ZonePermission.zone_id)
        .order_by(Zone.name)
    )
    out: dict[uuid.UUID, list[tuple[Zone, str]]] = {}
    for group_id, zone, mode in rows:
        out.setdefault(group_id, []).append((zone, mode))
    return out


async def delete_group(session: AsyncSession, group: Group) -> None:
    """Remove a group, unless a zone's access depends on it.

    `zone_permissions.group_id` is `ON DELETE CASCADE`, so deleting a group that holds
    the only `exclusive` row on a zone does not fail — it silently deletes the rule and
    the zone becomes bookable by the whole company. Nothing anywhere would report that:
    the desks simply turn green one morning. So the refusal names the zones and the
    admin clears the permission in the floor plan editor first, where they can see what
    they are opening up.
    """
    gated = await zones_gated_by(session, group.id)
    if gated:
        raise AdminRefusal(
            "a zone's access depends on this group",
            violations=[
                Violation(
                    code=codes.GROUP_IN_USE,
                    params={
                        "group": group.name,
                        "zones": [zone.name for zone, _ in gated],
                        "modes": sorted({mode for _, mode in gated}),
                    },
                    severity="block",
                )
            ],
        )
    await session.delete(group)
    await session.flush()


async def add_member(
    session: AsyncSession, *, group: Group, user: User, role: str = "member"
) -> GroupMember:
    existing = await session.scalar(
        select(GroupMember).where(GroupMember.group_id == group.id, GroupMember.user_id == user.id)
    )
    if existing is not None:
        # Idempotent: adding someone twice is a double-click, not an error.
        existing.role = role
        await session.flush()
        return existing
    member = GroupMember(
        id=uuid7(),
        organization_id=group.organization_id,
        group_id=group.id,
        user_id=user.id,
        role=role,
    )
    session.add(member)
    await session.flush()
    return member


async def remove_member(session: AsyncSession, *, group_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    member = await session.scalar(
        select(GroupMember).where(GroupMember.group_id == group_id, GroupMember.user_id == user_id)
    )
    if member is None:
        return False
    await session.delete(member)
    await session.flush()
    return True
