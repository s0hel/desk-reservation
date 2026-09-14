"""User, group and role administration (FR-8.4).

The tests that matter here are the refusals and the side effects, not the CRUD. Three
things can go quietly wrong in this area, and each one is silent in a way that only
shows up later:

- a "deactivated" user whose access token keeps working until it expires,
- an organization left with no administrator and no way back,
- a deleted group that takes an `exclusive` zone permission with it, turning a
  restricted neighbourhood into open seating with nothing reported anywhere.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import Range

from app.core.errors import PolicyViolation
from app.core.ids import uuid7
from app.core.time import now_utc
from app.db.session import SessionFactory, _apply_tenant
from app.models import (
    Booking,
    Floor,
    Group,
    GroupMember,
    Organization,
    OrgDomain,
    RefreshToken,
    Resource,
    RoleAssignment,
    Site,
    User,
    Zone,
    ZonePermission,
)
from app.services import people as people_service
from app.services.booking import BookingRequest, create_booking

HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}
MONDAY = date(2026, 9, 14)


class World:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    zone: uuid.UUID
    desks: list[uuid.UUID]
    eng: uuid.UUID
    #: The only org_admin.
    boss: uuid.UUID
    #: An ordinary employee holding a desk.
    priya: uuid.UUID


@pytest.fixture
async def world(session_for) -> World:
    w = World()
    w.org = uuid.uuid4()
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, w.org)
        s.add(Organization(id=w.org, name="p", slug=f"p-{w.org.hex[:8]}"))
        await s.flush()

        site = Site(
            id=uuid7(),
            organization_id=w.org,
            name="HQ",
            timezone="Europe/Berlin",
            opening_hours=HOURS,
        )
        s.add(site)
        await s.flush()
        floor = Floor(id=uuid7(), organization_id=w.org, site_id=site.id, name="F1")
        s.add(floor)
        await s.flush()
        zone = Zone(id=uuid7(), organization_id=w.org, floor_id=floor.id, name="Quiet corner")
        s.add(zone)
        await s.flush()
        w.site, w.floor, w.zone = site.id, floor.id, zone.id

        w.desks = []
        for i in range(4):
            r = Resource(
                id=uuid7(),
                organization_id=w.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="desk",
                code=f"D-{i:02d}",
                position={"x": 0.1 * i, "y": 0.5},
            )
            s.add(r)
            w.desks.append(r.id)
        await s.flush()

        group = Group(id=uuid7(), organization_id=w.org, name="Engineering")
        s.add(group)
        await s.flush()
        w.eng = group.id

        for attr, name, role in (
            ("boss", "Ada Boss", "org_admin"),
            ("priya", "Priya Raman", "employee"),
        ):
            u = User(
                id=uuid7(),
                organization_id=w.org,
                email=f"{attr}@example.com",
                display_name=name,
                home_site_id=site.id,
            )
            s.add(u)
            await s.flush()
            s.add(
                RoleAssignment(
                    id=uuid7(), organization_id=w.org, user_id=u.id, role=role, scope_type="org"
                )
            )
            s.add(GroupMember(id=uuid7(), organization_id=w.org, group_id=group.id, user_id=u.id))
            setattr(w, attr, u.id)
        await s.commit()
    return w


async def _user(s, user_id: uuid.UUID) -> User:
    return await s.scalar(select(User).where(User.id == user_id))


async def _book(s, *, user: User, desk: uuid.UUID, on: date) -> Booking:
    return await create_booking(
        s,
        actor=user,
        request=BookingRequest(resource_id=desk, local_date=on, user_id=user.id),
    )


# ------------------------------------------------------------------- deactivation


async def test_deactivation_releases_future_bookings_and_leaves_the_past_alone(world, session_for):
    async with session_for(world.org) as s:
        priya = await _user(s, world.priya)
        boss = await _user(s, world.boss)
        future = await _book(s, user=priya, desk=world.desks[0], on=MONDAY + timedelta(days=7))

        # A finished booking, written directly: `create_booking` refuses the past, which
        # is correct, and history is exactly what must survive a deactivation.
        past = Booking(
            id=uuid7(),
            organization_id=world.org,
            resource_id=world.desks[1],
            site_id=world.site,
            user_id=priya.id,
            booked_by_user_id=priya.id,
            local_date=date(2020, 1, 6),
            time_range=Range(
                datetime(2020, 1, 6, 7, tzinfo=UTC),
                datetime(2020, 1, 6, 19, tzinfo=UTC),
                bounds="[)",
            ),
            status="confirmed",
            created_at=now_utc(),
        )
        s.add(past)
        await s.flush()

        impact = await people_service.deactivation_impact(s, priya)
        assert impact.bookings == 1
        assert impact.sample == ["D-00"]
        assert impact.is_last_admin is False

        await people_service.deactivate(s, actor=boss, user=priya)

    async with session_for(world.org) as s:
        released = await s.scalar(select(Booking).where(Booking.id == future.id))
        assert released.status == "cancelled"
        # Untouched: it already happened.
        assert (await s.scalar(select(Booking).where(Booking.id == past.id))).status == "confirmed"


async def test_deactivation_ends_the_session_it_does_not_just_mark_the_row(world, session_for):
    """A deactivated user whose token still works is not deactivated.

    `current_user` checks `deactivated_at` AND compares `token_version` against the
    claim, so bumping the version is what kills an access token already in someone's
    pocket — and keeps it dead if the account is later reactivated.
    """
    async with session_for(world.org) as s:
        priya = await _user(s, world.priya)
        before = priya.token_version
        s.add(
            RefreshToken(
                id=uuid7(),
                organization_id=world.org,
                user_id=priya.id,
                family_id=uuid7(),
                token_hash=uuid7().hex,
                expires_at=now_utc() + timedelta(days=30),
            )
        )
        await s.flush()
        await people_service.deactivate(s, actor=await _user(s, world.boss), user=priya)

    async with session_for(world.org) as s:
        priya = await _user(s, world.priya)
        assert priya.deactivated_at is not None
        assert priya.status == "inactive"
        assert priya.token_version == before + 1
        live = await s.scalars(
            select(RefreshToken).where(
                RefreshToken.user_id == priya.id, RefreshToken.revoked_at.is_(None)
            )
        )
        assert list(live) == []


async def test_cancellation_goes_through_the_booking_service_so_the_person_is_told(
    world, session_for
):
    """FR-8.4 releases the desk; the outbox event is how the holder finds out.

    A bulk UPDATE would free the desk and tell nobody, which is the same half-done
    cancellation the blackout path exists to avoid.
    """
    from app.models import Outbox

    async with session_for(world.org) as s:
        priya = await _user(s, world.priya)
        await _book(s, user=priya, desk=world.desks[0], on=MONDAY + timedelta(days=7))
        await people_service.deactivate(s, actor=await _user(s, world.boss), user=priya)

    async with session_for(world.org) as s:
        events = list(
            await s.scalars(select(Outbox).where(Outbox.event_type == "booking.cancelled"))
        )
        assert len(events) == 1


async def test_reactivation_does_not_give_the_desks_back(world, session_for):
    async with session_for(world.org) as s:
        priya = await _user(s, world.priya)
        booking = await _book(s, user=priya, desk=world.desks[0], on=MONDAY + timedelta(days=7))
        await people_service.deactivate(s, actor=await _user(s, world.boss), user=priya)
        await people_service.reactivate(s, priya)

    async with session_for(world.org) as s:
        assert (await _user(s, world.priya)).deactivated_at is None
        assert (await s.scalar(select(Booking).where(Booking.id == booking.id))).status == (
            "cancelled"
        )


# --------------------------------------------------------------- the admin guard


async def test_the_last_administrator_cannot_be_deactivated(world, session_for):
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        impact = await people_service.deactivation_impact(s, boss)
        assert impact.is_last_admin is True
        with pytest.raises(PolicyViolation) as refusal:
            await people_service.deactivate(s, actor=boss, user=boss)
    assert refusal.value.violations[0].code == "admin.last_org_admin"


async def test_the_last_administrator_cannot_demote_themselves(world, session_for):
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        with pytest.raises(PolicyViolation) as refusal:
            await people_service.set_roles(
                s, actor=boss, user=boss, assignments=[("employee", "org", None)]
            )
    assert refusal.value.violations[0].code == "admin.last_org_admin"


async def test_a_second_administrator_unlocks_the_first(world, session_for):
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        priya = await _user(s, world.priya)
        await people_service.set_roles(
            s,
            actor=boss,
            user=priya,
            assignments=[("employee", "org", None), ("org_admin", "org", None)],
        )
        # Now there are two, so the first may step down.
        await people_service.set_roles(
            s, actor=boss, user=boss, assignments=[("employee", "org", None)]
        )

    async with session_for(world.org) as s:
        roles = await people_service.roles_of(s, [world.boss])
        assert [r.role for r in roles[world.boss]] == ["employee"]


async def test_one_admin_holding_the_role_twice_is_still_one_admin(world, session_for):
    """Counting rows rather than people would read two scopes as two administrators and
    let the only one walk straight past the guard."""
    async with session_for(world.org) as s:
        s.add(
            RoleAssignment(
                id=uuid7(),
                organization_id=world.org,
                user_id=world.boss,
                role="org_admin",
                scope_type="site",
                scope_id=world.site,
            )
        )
        await s.flush()
        assert await people_service.other_active_admins(s, excluding=world.priya) == 1
        with pytest.raises(PolicyViolation):
            await people_service.deactivate(
                s, actor=await _user(s, world.boss), user=await _user(s, world.boss)
            )


async def test_a_deactivated_administrator_does_not_count(world, session_for):
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        priya = await _user(s, world.priya)
        await people_service.set_roles(
            s, actor=boss, user=priya, assignments=[("org_admin", "org", None)]
        )
        await people_service.deactivate(s, actor=boss, user=priya)
        # Priya is an admin on paper and cannot administer anything, so the guard must
        # not count her as the survivor that lets the boss leave.
        assert await people_service.other_active_admins(s, excluding=boss.id) == 0


async def test_setting_roles_retires_the_old_token(world, session_for):
    """Otherwise a demoted admin keeps admin until their access token expires."""
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        priya = await _user(s, world.priya)
        before = priya.token_version
        await people_service.set_roles(
            s, actor=boss, user=priya, assignments=[("team_lead", "site", world.site)]
        )
        assert priya.token_version == before + 1


async def test_an_unknown_role_is_refused_by_name(world, session_for):
    async with session_for(world.org) as s:
        with pytest.raises(PolicyViolation) as refusal:
            await people_service.set_roles(
                s,
                actor=await _user(s, world.boss),
                user=await _user(s, world.priya),
                assignments=[("superuser", "org", None)],
            )
    assert refusal.value.violations[0].code == "admin.unknown_role"


async def test_an_org_scoped_role_never_keeps_a_scope_id(world, session_for):
    async with session_for(world.org) as s:
        await people_service.set_roles(
            s,
            actor=await _user(s, world.boss),
            user=await _user(s, world.priya),
            assignments=[("employee", "org", world.site)],
        )
    async with session_for(world.org) as s:
        roles = await people_service.roles_of(s, [world.priya])
        assert roles[world.priya][0].scope_id is None


# --------------------------------------------------------------------- the users


async def test_a_duplicate_address_is_a_refusal_not_a_server_error(world, session_for):
    async with session_for(world.org) as s:
        with pytest.raises(PolicyViolation) as refusal:
            await people_service.create_user(
                s,
                organization_id=world.org,
                # The column is citext, so the check has to be case-insensitive too.
                email="PRIYA@EXAMPLE.COM",
                display_name="Someone Else",
            )
    assert refusal.value.violations[0].code == "admin.email_taken"


async def test_a_new_user_can_actually_sign_in(world, session_for):
    """Created with no roles at all, every route refuses them — including the ones that
    only need `employee`. The base role is part of creating a person, not a later step."""
    async with session_for(world.org) as s:
        created = await people_service.create_user(
            s, organization_id=world.org, email="new@example.com", display_name="New Person"
        )
    async with session_for(world.org) as s:
        roles = await people_service.roles_of(s, [created.id])
        assert [r.role for r in roles[created.id]] == ["employee"]


# -------------------------------------------------------------------- the groups


async def test_a_group_a_zone_depends_on_cannot_be_deleted(world, session_for):
    """`zone_permissions.group_id` is ON DELETE CASCADE, so deleting the group would
    succeed and silently open the zone to the whole company."""
    async with session_for(world.org) as s:
        s.add(
            ZonePermission(
                id=uuid7(),
                organization_id=world.org,
                zone_id=world.zone,
                group_id=world.eng,
                mode="exclusive",
            )
        )
        await s.flush()
        group = await people_service.group_or_404(s, world.eng)
        with pytest.raises(PolicyViolation) as refusal:
            await people_service.delete_group(s, group)

    violation = refusal.value.violations[0]
    assert violation.code == "admin.group_in_use"
    # Naming the zone is the point: the admin has to know where to go and clear it.
    assert violation.params["zones"] == ["Quiet corner"]

    async with session_for(world.org) as s:
        assert await s.scalar(select(ZonePermission).where(ZonePermission.group_id == world.eng))


async def test_a_group_nothing_depends_on_is_deleted_with_its_memberships(world, session_for):
    async with session_for(world.org) as s:
        group = await people_service.group_or_404(s, world.eng)
        await people_service.delete_group(s, group)

    async with session_for(world.org) as s:
        assert await s.scalar(select(Group).where(Group.id == world.eng)) is None
        left = await s.scalars(select(GroupMember).where(GroupMember.group_id == world.eng))
        assert list(left) == []


async def test_adding_the_same_person_twice_is_not_an_error(world, session_for):
    async with session_for(world.org) as s:
        group = await people_service.group_or_404(s, world.eng)
        priya = await _user(s, world.priya)
        await people_service.add_member(s, group=group, user=priya, role="lead")
        await people_service.add_member(s, group=group, user=priya, role="lead")

    async with session_for(world.org) as s:
        rows = list(
            await s.scalars(
                select(GroupMember).where(
                    GroupMember.group_id == world.eng, GroupMember.user_id == world.priya
                )
            )
        )
        assert len(rows) == 1
        assert rows[0].role == "lead"


async def test_group_membership_survives_deactivation(world, session_for):
    """Removing them from their team as well would quietly rewrite the team's history
    and, for a zone held by that team, change who could book it — two consequences
    nobody asked for when they deactivated an account."""
    async with session_for(world.org) as s:
        await people_service.deactivate(
            s, actor=await _user(s, world.boss), user=await _user(s, world.priya)
        )

    async with session_for(world.org) as s:
        still = await s.scalar(select(GroupMember).where(GroupMember.user_id == world.priya))
        assert still is not None


async def test_counts_come_back_for_every_group_in_one_pass(world, session_for):
    async with session_for(world.org) as s:
        counts = await people_service.member_counts(s)
        assert counts[world.eng] == 2
        assert await people_service.zone_gating(s) == {}


# ------------------------------------------------------- through the HTTP layer


@pytest.fixture
async def client():
    import httpx
    from httpx import ASGITransport

    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def _token(client, email: str) -> str:
    response = await client.post("/v1/auth/dev-login", json={"email": email})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture
async def admin_headers(world, client, session_for) -> dict[str, str]:
    async with session_for(world.org) as s:
        boss = await _user(s, world.boss)
        # Dev-login resolves the tenant from the email domain, so the org needs a row.
        await s.execute(
            OrgDomain.__table__.insert().values(
                id=uuid7(),
                organization_id=world.org,
                domain=f"{world.org.hex[:8]}.example",
                created_at=now_utc(),
                updated_at=now_utc(),
            )
        )
        boss.email = f"boss@{world.org.hex[:8]}.example"
        await s.flush()
        email = boss.email
    return {"authorization": f"Bearer {await _token(client, email)}"}


async def test_a_write_route_can_read_back_what_it_just_wrote(world, client, admin_headers):
    """The regression test for the bug that shipped in this module's first draft.

    Every write route here answers with the state it produced, and an early
    `session.commit()` ends the transaction that `SET LOCAL app.org_id` lives in
    (TDD §18.2). The read-back then runs with no tenant context, RLS returns nothing,
    and the route 404s on the row it has just written — a group that cannot be joined,
    reporting that the group does not exist.

    Nothing below the HTTP layer catches it: the service functions are correct, and a
    test that drives them directly never commits mid-request.
    """
    response = await client.post(
        f"/v1/admin/groups/{world.eng}/members",
        headers=admin_headers,
        json={"user_id": str(world.priya)},
    )
    assert response.status_code == 200, response.text
    assert [m["display_name"] for m in response.json()] == ["Ada Boss", "Priya Raman"]


async def test_every_write_route_answers_with_the_row_it_wrote(world, client, admin_headers):
    """The same trap, on each of the other shapes: create, patch, delete-member."""
    created = await client.post("/v1/admin/groups", headers=admin_headers, json={"name": "Design"})
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]

    renamed = await client.patch(
        f"/v1/admin/groups/{group_id}", headers=admin_headers, json={"name": "Design & Research"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Design & Research"

    person = await client.post(
        "/v1/admin/users",
        headers=admin_headers,
        json={"email": "new.person@example.com", "display_name": "New Person"},
    )
    assert person.status_code == 201, person.text
    assert [r["role"] for r in person.json()["roles"]] == ["employee"]

    patched = await client.patch(
        f"/v1/admin/users/{person.json()['id']}",
        headers=admin_headers,
        json={"display_name": "Renamed Person"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["display_name"] == "Renamed Person"

    removed = await client.delete(
        f"/v1/admin/groups/{group_id}/members/{world.priya}", headers=admin_headers
    )
    assert removed.status_code == 200, removed.text


async def test_a_site_admin_cannot_hand_themselves_the_org(world, client, session_for):
    """Role assignment is `org_admin` only: a site admin who can grant roles can grant
    themselves `org_admin`, which is not delegation but the absence of a boundary."""
    async with session_for(world.org) as s:
        await s.execute(
            OrgDomain.__table__.insert().values(
                id=uuid7(),
                organization_id=world.org,
                domain=f"site-{world.org.hex[:8]}.example",
                created_at=now_utc(),
                updated_at=now_utc(),
            )
        )
        priya = await _user(s, world.priya)
        priya.email = f"priya@site-{world.org.hex[:8]}.example"
        s.add(
            RoleAssignment(
                id=uuid7(),
                organization_id=world.org,
                user_id=priya.id,
                role="site_admin",
                scope_type="org",
            )
        )
        await s.flush()
        email = priya.email

    import httpx
    from httpx import ASGITransport

    from app.main import app

    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        headers = {"authorization": f"Bearer {await _token(c, email)}"}
        # They can see the directory…
        assert (await c.get("/v1/admin/users", headers=headers)).status_code == 200
        # …and cannot promote themselves.
        refused = await c.put(
            f"/v1/admin/users/{world.priya}/roles",
            headers=headers,
            json={"roles": [{"role": "org_admin", "scope_type": "org", "scope_id": None}]},
        )
        assert refused.status_code == 403
