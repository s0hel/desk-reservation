"""Seed a realistic tenant: one org, one site, two floors, 120 desks, 6 rooms (TDD §21).

Note the bootstrap detail: RLS is FORCEd, so even creating the organization requires a
tenant context. We generate the org id client-side and set app.org_id to it before the
first insert. Production org provisioning will need the same deliberate step — there is
no ambient superuser path, which is the point.
"""

import asyncio
import uuid

from sqlalchemy import text

from app.core.ids import uuid7
from app.db.session import SessionFactory, _apply_tenant
from app.models import (
    Floor,
    Group,
    GroupMember,
    IdentityProvider,
    Organization,
    OrgDomain,
    Resource,
    RoleAssignment,
    Site,
    User,
    Zone,
)

ORG_ID = uuid.UUID("018f0000-0000-7000-8000-000000000001")
DOMAIN = "example.com"

OPENING_HOURS = {
    "mon": ["07:00", "20:00"],
    "tue": ["07:00", "20:00"],
    "wed": ["07:00", "20:00"],
    "thu": ["07:00", "20:00"],
    "fri": ["07:00", "20:00"],
}

#: email, name, role, team, presence visibility (FR-5.6).
PEOPLE = [
    ("priya.raman@example.com", "Priya Raman", "employee", "Engineering", "everyone"),
    ("marcus.hale@example.com", "Marcus Hale", "team_lead", "Engineering", "everyone"),
    ("dana.okafor@example.com", "Dana Okafor", "site_admin", "Design", "team_only"),
    ("sam.vasquez@example.com", "Sam Vasquez", "org_admin", "Design", "nobody"),
]

DESK_ATTRS = [
    {"sit_stand": True, "monitors": 2, "dock": "thunderbolt", "window": True},
    {"sit_stand": False, "monitors": 1, "dock": "usb_c"},
    {"sit_stand": True, "monitors": 2, "dock": "dual", "quiet": True},
    {"sit_stand": False, "monitors": 0, "dock": "none", "accessible": True},
]

ROOMS = [
    ("Ada", 4, {"display": True, "video_conf": True}),
    ("Babbage", 8, {"display": True, "video_conf": True, "whiteboard": True}),
    ("Curie", 2, {"phone": True}),
    ("Dijkstra", 12, {"display": True, "video_conf": True, "whiteboard": True}),
    ("Euler", 6, {"whiteboard": True}),
    ("Fermi", 2, {"phone": True}),
]


async def seed() -> None:
    async with SessionFactory() as s:
        await s.begin()
        await _apply_tenant(s, ORG_ID)

        exists = await s.scalar(
            text("SELECT 1 FROM organizations WHERE id = :i").bindparams(i=ORG_ID)
        )
        if exists:
            print("already seeded — run `make db-reset` to start clean")
            await s.rollback()
            return

        # Staged flushes. With the whole graph in one flush the unit of work does not
        # reliably emit the organization before its children, so the tenant row is
        # committed to the transaction first and everything else hangs off it.
        s.add(
            Organization(
                id=ORG_ID,
                name="Example Corp",
                slug="example",
                primary_domain=DOMAIN,
                settings={"presence_enabled": True},
            )
        )
        await s.flush()

        s.add(OrgDomain(id=uuid7(), organization_id=ORG_ID, domain=DOMAIN))
        s.add(IdentityProvider(id=uuid7(), organization_id=ORG_ID, kind="magic_link", enabled=True))
        await s.flush()

        site = Site(
            id=uuid7(),
            organization_id=ORG_ID,
            name="Berlin HQ",
            # What the home screen greets you with: "Welcome to Berlin, Priya". The
            # full name is what an admin files it under (FR-2.1).
            short_name="Berlin",
            address="Torstrasse 1, 10119 Berlin",
            timezone="Europe/Berlin",
            geo_lat=52.5296,
            geo_lng=13.4021,
            geofence_radius_m=150,
            opening_hours=OPENING_HOURS,
            daily_capacity_cap=100,
            checkin_enabled=True,
        )
        s.add(site)
        await s.flush()

        teams = {
            name: Group(id=uuid7(), organization_id=ORG_ID, name=name)
            for name in ("Engineering", "Design")
        }
        for group in teams.values():
            s.add(group)
        await s.flush()

        users: list[User] = []
        for email, name, _role, _team, visibility in PEOPLE:
            u = User(
                id=uuid7(),
                organization_id=ORG_ID,
                email=email,
                display_name=name,
                home_site_id=site.id,
                locale="en",
                presence_visibility=visibility,
            )
            s.add(u)
            users.append(u)
        await s.flush()
        for u, (_, _, role, team, _visibility) in zip(users, PEOPLE, strict=True):
            s.add(RoleAssignment(id=uuid7(), organization_id=ORG_ID, user_id=u.id, role=role))
            s.add(
                GroupMember(
                    id=uuid7(),
                    organization_id=ORG_ID,
                    group_id=teams[team].id,
                    user_id=u.id,
                    role="lead" if role == "team_lead" else "member",
                )
            )

        desk_total = 0
        for ordinal, (floor_name, rows, cols) in enumerate(
            [("Floor 3", 5, 12), ("Floor 4", 5, 12)], start=3
        ):
            floor = Floor(
                id=uuid7(),
                organization_id=ORG_ID,
                site_id=site.id,
                name=floor_name,
                ordinal=ordinal,
                plan_width_px=2400,
                plan_height_px=1600,
            )
            s.add(floor)
            await s.flush()

            zone = Zone(
                id=uuid7(),
                organization_id=ORG_ID,
                floor_id=floor.id,
                name=f"{floor_name} — Engineering",
                polygon=[[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
                color="#4F7DF3",
            )
            s.add(zone)
            await s.flush()

            for r in range(rows):
                for c in range(cols):
                    desk_total += 1
                    s.add(
                        Resource(
                            id=uuid7(),
                            organization_id=ORG_ID,
                            site_id=site.id,
                            floor_id=floor.id,
                            zone_id=zone.id,
                            kind="desk",
                            code=f"{ordinal}F-{chr(65 + r)}-{c + 1:02d}",
                            # normalized plan space, 0..1 (TDD §14.2)
                            position={
                                "x": round(0.08 + c * 0.075, 4),
                                "y": round(0.15 + r * 0.16, 4),
                                "rotation": 0,
                            },
                            capacity=1,
                            attributes=DESK_ATTRS[(r + c) % len(DESK_ATTRS)],
                        )
                    )

            if ordinal == 4:
                for i, (name, cap, attrs) in enumerate(ROOMS):
                    s.add(
                        Resource(
                            id=uuid7(),
                            organization_id=ORG_ID,
                            site_id=site.id,
                            floor_id=floor.id,
                            kind="room",
                            code=f"4F-R-{i + 1:02d}",
                            name=name,
                            capacity=cap,
                            position={"x": round(0.10 + i * 0.14, 4), "y": 0.92, "rotation": 0},
                            attributes=attrs,
                        )
                    )

        await s.commit()
        print(f"seeded org={ORG_ID} site='Berlin HQ' desks={desk_total} rooms={len(ROOMS)}")
        print(f'sign in with:  POST /v1/auth/dev-login  {{"email": "{PEOPLE[0][0]}"}}')


if __name__ == "__main__":
    asyncio.run(seed())
