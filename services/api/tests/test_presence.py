"""Presence and its visibility rules (FR-5.1–5.6, PRD Q6).

The privacy tests here are the point of the file. Every one of them asserts absence
from a result set rather than the presence of a `hidden` flag, because that is the
guarantee: a user who opts out is not returned, so no client can leak them by ignoring
a field (TDD §11).
"""

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.core.errors import NotFound, PolicyViolation
from app.core.ids import uuid7
from app.db.session import SessionFactory, _apply_tenant
from app.models import Floor, Group, GroupMember, Organization, Resource, Site, User
from app.services import presence as presence_service
from app.services.booking import BookingRequest, create_booking

MONDAY = date(2026, 9, 14)
HOURS = {d: ["07:00", "20:00"] for d in ("mon", "tue", "wed", "thu", "fri")}


class World:
    org: uuid.UUID
    site: uuid.UUID
    floor: uuid.UUID
    desks: list[uuid.UUID]
    eng: uuid.UUID
    design: uuid.UUID
    #: Engineering, visible to everyone.
    priya: uuid.UUID
    #: Engineering, visible to everyone.
    marcus: uuid.UUID
    #: Design, team_only — invisible to Engineering, visible to Sam.
    dana: uuid.UUID
    #: Design, nobody — invisible to everyone including their own team.
    sam: uuid.UUID


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
        w.site, w.floor = site.id, floor.id

        w.desks = []
        for i in range(6):
            r = Resource(
                id=uuid7(),
                organization_id=w.org,
                site_id=site.id,
                floor_id=floor.id,
                kind="desk",
                code=f"D-{i:02d}",
                capacity=1,
                attributes={},
                position={"x": 0.1 * i, "y": 0.5},
            )
            s.add(r)
            w.desks.append(r.id)

        eng = Group(id=uuid7(), organization_id=w.org, name="Engineering")
        design = Group(id=uuid7(), organization_id=w.org, name="Design")
        s.add_all([eng, design])
        await s.flush()
        w.eng, w.design = eng.id, design.id

        people = [
            ("priya", "Priya Raman", "everyone", eng.id),
            ("marcus", "Marcus Hale", "everyone", eng.id),
            ("dana", "Dana Okafor", "team_only", design.id),
            ("sam", "Sam Vasquez", "nobody", design.id),
        ]
        for attr, name, visibility, group_id in people:
            u = User(
                id=uuid7(),
                organization_id=w.org,
                email=f"{attr}-{w.org.hex[:6]}@p.example",
                display_name=name,
                home_site_id=site.id,
                presence_visibility=visibility,
            )
            s.add(u)
            await s.flush()
            s.add(GroupMember(id=uuid7(), organization_id=w.org, group_id=group_id, user_id=u.id))
            setattr(w, attr, u.id)
        await s.commit()
    return w


async def _session(org):
    s = SessionFactory()
    await s.begin()
    await _apply_tenant(s, org)
    return s


async def _user(s, user_id: uuid.UUID) -> User:
    return await s.scalar(select(User).where(User.id == user_id))


async def _book(w: World, user_id: uuid.UUID, desk: uuid.UUID, day: date = MONDAY) -> None:
    s = await _session(w.org)
    try:
        await create_booking(
            s,
            actor=await _user(s, user_id),
            request=BookingRequest(
                resource_id=desk, local_date=day, slot="full_day", idempotency_key=str(uuid7())
            ),
        )
        await s.commit()
    finally:
        await s.close()


# ── FR-5.1 who's in ───────────────────────────────────────────────────────────


async def test_who_is_in_lists_colleagues_with_a_desk(world):
    await _book(world, world.priya, world.desks[0])
    await _book(world, world.marcus, world.desks[1])

    s = await _session(world.org)
    try:
        people = await presence_service.who_is_in(
            s, viewer=await _user(s, world.priya), site_id=world.site, local_date=MONDAY
        )
        assert [p.display_name for p in people] == ["Marcus Hale", "Priya Raman"]
        assert {p.is_me for p in people} == {True, False}
    finally:
        await s.rollback()
        await s.close()


async def test_who_is_in_carries_the_seat_so_sit_near_needs_no_second_call(world):
    """FR-5.3 is a client-side proximity sort over normalized plan coordinates."""
    await _book(world, world.marcus, world.desks[3])

    s = await _session(world.org)
    try:
        people = await presence_service.who_is_in(
            s, viewer=await _user(s, world.priya), site_id=world.site, local_date=MONDAY
        )
        seat = people[0].seat
        assert seat is not None
        assert seat.resource_code == "D-03"
        assert seat.floor_id == world.floor
        assert seat.position == {"x": pytest.approx(0.3), "y": 0.5}
    finally:
        await s.rollback()
        await s.close()


async def test_who_is_in_is_scoped_to_the_day(world):
    await _book(world, world.marcus, world.desks[0], day=MONDAY + timedelta(days=1))

    s = await _session(world.org)
    try:
        viewer = await _user(s, world.priya)
        assert (
            await presence_service.who_is_in(
                s, viewer=viewer, site_id=world.site, local_date=MONDAY
            )
            == []
        )
        tomorrow = await presence_service.who_is_in(
            s, viewer=viewer, site_id=world.site, local_date=MONDAY + timedelta(days=1)
        )
        assert [p.display_name for p in tomorrow] == ["Marcus Hale"]
    finally:
        await s.rollback()
        await s.close()


# ── FR-5.6 visibility ─────────────────────────────────────────────────────────


async def test_nobody_is_invisible_even_to_their_own_team(world):
    await _book(world, world.sam, world.desks[0])
    await _book(world, world.dana, world.desks[1])

    s = await _session(world.org)
    try:
        # Dana shares the Design group with Sam, and still cannot see them.
        people = await presence_service.who_is_in(
            s, viewer=await _user(s, world.dana), site_id=world.site, local_date=MONDAY
        )
        assert [p.display_name for p in people] == ["Dana Okafor"]
    finally:
        await s.rollback()
        await s.close()


async def test_team_only_is_hidden_from_other_teams_and_shown_to_their_own(world):
    await _book(world, world.dana, world.desks[0])

    s = await _session(world.org)
    try:
        # Priya is in Engineering: Dana must not appear at all.
        outsider = await presence_service.who_is_in(
            s, viewer=await _user(s, world.priya), site_id=world.site, local_date=MONDAY
        )
        assert outsider == []

        # Sam is in Design, so Dana is visible to them.
        insider = await presence_service.who_is_in(
            s, viewer=await _user(s, world.sam), site_id=world.site, local_date=MONDAY
        )
        assert [p.display_name for p in insider] == ["Dana Okafor"]
    finally:
        await s.rollback()
        await s.close()


async def test_you_always_see_yourself_whatever_you_set(world):
    await _book(world, world.sam, world.desks[0])

    s = await _session(world.org)
    try:
        people = await presence_service.who_is_in(
            s, viewer=await _user(s, world.sam), site_id=world.site, local_date=MONDAY
        )
        assert [p.display_name for p in people] == ["Sam Vasquez"]
        assert people[0].is_me is True
    finally:
        await s.rollback()
        await s.close()


async def test_a_hidden_colleagues_days_are_not_found_rather_than_forbidden(world):
    """Refusing by name would confirm the person exists and chose to hide, which is the
    fact they hid."""
    s = await _session(world.org)
    try:
        with pytest.raises(NotFound):
            await presence_service.user_presence(
                s, viewer=await _user(s, world.priya), user_id=world.sam, dates=[MONDAY]
            )
    finally:
        await s.rollback()
        await s.close()


async def test_search_never_returns_someone_who_opted_out(world):
    s = await _session(world.org)
    try:
        viewer = await _user(s, world.priya)
        assert [
            u.display_name
            for u in await presence_service.search_colleagues(s, viewer=viewer, query="Vasquez")
        ] == []
        assert [
            u.display_name
            for u in await presence_service.search_colleagues(s, viewer=viewer, query="Okafor")
        ] == []
        assert [
            u.display_name
            for u in await presence_service.search_colleagues(s, viewer=viewer, query="hale")
        ] == ["Marcus Hale"]
    finally:
        await s.rollback()
        await s.close()


async def test_search_ignores_a_one_character_query(world):
    """Otherwise "a" enumerates everyone who left presence on."""
    s = await _session(world.org)
    try:
        found = await presence_service.search_colleagues(
            s, viewer=await _user(s, world.priya), query="a"
        )
        assert found == []
    finally:
        await s.rollback()
        await s.close()


async def test_a_deactivated_colleague_disappears(world):
    s = await _session(world.org)
    try:
        marcus = await _user(s, world.marcus)
        marcus.status = "deactivated"
        await s.flush()
        found = await presence_service.search_colleagues(
            s, viewer=await _user(s, world.priya), query="Hale"
        )
        assert found == []
    finally:
        await s.rollback()
        await s.close()


# ── FR-5.4 team grid ──────────────────────────────────────────────────────────


async def test_team_grid_defaults_to_the_viewers_own_group(world):
    s = await _session(world.org)
    try:
        group, members = await presence_service.team_grid(
            s, viewer=await _user(s, world.priya), group_id=None, dates=[MONDAY]
        )
        assert group is not None and group.name == "Engineering"
        assert [m.display_name for m in members] == ["Marcus Hale", "Priya Raman"]
    finally:
        await s.rollback()
        await s.close()


async def test_team_grid_of_a_group_you_are_not_in_is_empty(world):
    s = await _session(world.org)
    try:
        group, members = await presence_service.team_grid(
            s, viewer=await _user(s, world.priya), group_id=world.design, dates=[MONDAY]
        )
        assert group is None
        assert members == []
    finally:
        await s.rollback()
        await s.close()


async def test_team_grid_mixes_bookings_absences_and_silence(world):
    await _book(world, world.marcus, world.desks[2])

    s = await _session(world.org)
    try:
        await presence_service.declare_absence(
            s, user=await _user(s, world.priya), local_date=MONDAY, kind="remote"
        )
        await s.commit()
    finally:
        await s.close()

    s = await _session(world.org)
    try:
        _, members = await presence_service.team_grid(
            s,
            viewer=await _user(s, world.priya),
            group_id=None,
            dates=[MONDAY, MONDAY + timedelta(days=1)],
        )
        by_name = {m.display_name: m for m in members}
        assert by_name["Marcus Hale"].days[0].status == "in"
        assert by_name["Marcus Hale"].days[0].seat is not None
        assert by_name["Priya Raman"].days[0].status == "remote"
        assert by_name["Priya Raman"].days[0].seat is None
        # A day nobody has said anything about is "unknown", not "out" — the product
        # must not infer absence from silence.
        assert by_name["Priya Raman"].days[1].status == "unknown"
    finally:
        await s.rollback()
        await s.close()


# ── FR-5.5 absences ───────────────────────────────────────────────────────────


async def test_declaring_an_absence_is_refused_while_a_desk_is_held(world):
    await _book(world, world.priya, world.desks[0])

    s = await _session(world.org)
    try:
        with pytest.raises(PolicyViolation) as caught:
            await presence_service.declare_absence(
                s, user=await _user(s, world.priya), local_date=MONDAY, kind="leave"
            )
        violation = caught.value.violations[0]
        assert violation.code == "presence.absence_conflicts_with_booking"
        # The client needs the booking to offer "cancel it and mark me away".
        assert violation.params["resource_code"] == "D-00"
        assert "booking_id" in violation.params
    finally:
        await s.rollback()
        await s.close()


async def test_declaring_twice_updates_rather_than_duplicates(world):
    s = await _session(world.org)
    try:
        user = await _user(s, world.priya)
        await presence_service.declare_absence(s, user=user, local_date=MONDAY, kind="remote")
        await presence_service.declare_absence(s, user=user, local_date=MONDAY, kind="leave")
        rows = await presence_service.absences_between(s, user=user, start=MONDAY, end=MONDAY)
        assert [(a.local_date, a.kind) for a in rows] == [(MONDAY, "leave")]
    finally:
        await s.rollback()
        await s.close()


async def test_an_unknown_absence_kind_is_refused_with_a_code(world):
    s = await _session(world.org)
    try:
        with pytest.raises(PolicyViolation) as caught:
            await presence_service.declare_absence(
                s, user=await _user(s, world.priya), local_date=MONDAY, kind="sabbatical"
            )
        assert caught.value.violations[0].code == "presence.absence_kind_unknown"
    finally:
        await s.rollback()
        await s.close()


async def test_clearing_a_day_that_was_never_declared_is_not_an_error(world):
    s = await _session(world.org)
    try:
        user = await _user(s, world.priya)
        assert await presence_service.clear_absence(s, user=user, local_date=MONDAY) is False
        await presence_service.declare_absence(s, user=user, local_date=MONDAY, kind="travel")
        assert await presence_service.clear_absence(s, user=user, local_date=MONDAY) is True
        assert await presence_service.absences_between(s, user=user, start=MONDAY, end=MONDAY) == []
    finally:
        await s.rollback()
        await s.close()


# ── PRD Q6 org kill switch ────────────────────────────────────────────────────


async def test_presence_defaults_on_and_can_be_switched_off_per_tenant(world):
    s = await _session(world.org)
    try:
        assert await presence_service.presence_enabled(s, world.org) is True

        org = await s.scalar(select(Organization).where(Organization.id == world.org))
        org.settings = {**(org.settings or {}), "presence_enabled": False}
        await s.flush()

        assert await presence_service.presence_enabled(s, world.org) is False
        with pytest.raises(NotFound):
            await presence_service.require_presence(s, world.org)
    finally:
        await s.rollback()
        await s.close()


# ── visibility choices ────────────────────────────────────────────────────────


async def test_setting_an_unknown_visibility_is_refused(world):
    s = await _session(world.org)
    try:
        with pytest.raises(PolicyViolation) as caught:
            await presence_service.set_visibility(
                s, user=await _user(s, world.priya), visibility="everyne"
            )
        assert caught.value.violations[0].code == "presence.visibility_unknown"
    finally:
        await s.rollback()
        await s.close()


def test_initials_degrade_honestly():
    assert presence_service.initials_of("Priya Raman") == "PR"
    assert presence_service.initials_of("Sam") == "S"
    assert presence_service.initials_of("Ada Lovelace King") == "AL"
    assert presence_service.initials_of("") == "?"
