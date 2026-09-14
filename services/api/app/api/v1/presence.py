"""Colleague presence endpoints (FR-5.1–5.6, TDD §11).

Every route here is gated on the org kill switch first and carries the visibility
condition in its query. Neither is optional, and neither is something the client is
asked to help with.
"""

import uuid
from datetime import date, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, db
from app.core.errors import NotFound
from app.core.time import now_utc, to_local_date
from app.models import Site, User
from app.services import presence as presence_service

router = APIRouter(tags=["presence"])

AbsenceKind = Literal["remote", "leave", "travel"]


class SeatOut(BaseModel):
    floor_id: uuid.UUID
    floor_name: str
    resource_id: uuid.UUID
    resource_code: str
    #: Normalized plan coordinates, so "who is near whom" is a client-side sort over
    #: data it already has rather than another round trip (FR-5.3).
    position: dict


class PersonOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initials: str
    avatar_url: str | None
    status: str
    seat: SeatOut | None
    is_me: bool


class PresenceOut(BaseModel):
    site_id: uuid.UUID
    local_date: date
    #: No count field, deliberately. A total larger than this list would identify the
    #: people who opted out (TDD §11, PRD Q6) — the caller counts what it can name.
    people: list[PersonOut]


def _seat_out(seat: presence_service.Seat | None) -> SeatOut | None:
    return None if seat is None else SeatOut(**vars(seat))


def _person_out(person: presence_service.Person) -> PersonOut:
    return PersonOut(
        user_id=person.user_id,
        display_name=person.display_name,
        initials=presence_service.initials_of(person.display_name),
        avatar_url=person.avatar_url,
        status=person.status,
        seat=_seat_out(person.seat),
        is_me=person.is_me,
    )


async def _site_today(session: AsyncSession, site_id: uuid.UUID) -> tuple[Site, date]:
    site = await session.scalar(select(Site).where(Site.id == site_id))
    if site is None:
        raise NotFound("Site not found")
    return site, to_local_date(site.timezone, now_utc())


@router.get("/presence", response_model=PresenceOut)
async def who_is_in(
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    site_id: Annotated[uuid.UUID, Query(alias="site")],
    local_date: Annotated[date | None, Query(alias="date")] = None,
) -> PresenceOut:
    """Who is in at a site on a day (FR-5.1)."""
    await presence_service.require_presence(session, user.organization_id)
    site, today = await _site_today(session, site_id)
    day = local_date or today

    people = await presence_service.who_is_in(session, viewer=user, site_id=site.id, local_date=day)
    return PresenceOut(site_id=site.id, local_date=day, people=[_person_out(p) for p in people])


class DayPresenceOut(BaseModel):
    local_date: date
    status: str
    seat: SeatOut | None


class UserPresenceOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initials: str
    avatar_url: str | None
    days: list[DayPresenceOut]


@router.get("/users/{user_id}/presence", response_model=UserPresenceOut)
async def colleague_presence(
    user_id: uuid.UUID,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    site_id: Annotated[uuid.UUID | None, Query(alias="site")] = None,
    start: Annotated[date | None, Query(alias="from")] = None,
    days: Annotated[int, Query(ge=1, le=31)] = 14,
) -> UserPresenceOut:
    """One colleague's upcoming office days (FR-5.2), subject to their setting (FR-5.6).

    A colleague who has hidden themselves is a 404, not a 403: refusing by name would
    confirm both that they exist and that they chose to hide, which is the fact they hid.
    """
    await presence_service.require_presence(session, user.organization_id)

    first = start
    if first is None:
        # The site's day, never the device's (TDD §5). Falls back to the viewer's home
        # site when the caller did not name one.
        anchor = site_id or user.home_site_id
        if anchor is not None:
            _, first = await _site_today(session, anchor)
    if first is None:
        first = to_local_date("UTC", now_utc())

    dates = [first + timedelta(days=i) for i in range(days)]
    subject, presence = await presence_service.user_presence(
        session, viewer=user, user_id=user_id, dates=dates
    )
    return UserPresenceOut(
        user_id=subject.id,
        display_name=subject.display_name,
        initials=presence_service.initials_of(subject.display_name),
        avatar_url=subject.avatar_url,
        days=[
            DayPresenceOut(local_date=d.local_date, status=d.status, seat=_seat_out(d.seat))
            for d in presence
        ],
    )


class ColleagueOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initials: str
    avatar_url: str | None
    is_me: bool


@router.get("/colleagues", response_model=list[ColleagueOut])
async def search_colleagues(
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    q: Annotated[str, Query(min_length=2, max_length=100)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[ColleagueOut]:
    """Find a colleague by name (FR-5.2, and the first half of FR-5.3)."""
    await presence_service.require_presence(session, user.organization_id)
    found = await presence_service.search_colleagues(session, viewer=user, query=q, limit=limit)
    return [
        ColleagueOut(
            user_id=c.id,
            display_name=c.display_name,
            initials=presence_service.initials_of(c.display_name),
            avatar_url=c.avatar_url,
            is_me=c.id == user.id,
        )
        for c in found
    ]


class TeamMemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    initials: str
    avatar_url: str | None
    is_me: bool
    days: list[DayPresenceOut]


class TeamOut(BaseModel):
    group_id: uuid.UUID | None
    group_name: str | None
    dates: list[date]
    members: list[TeamMemberOut]


@router.get("/team", response_model=TeamOut)
async def team(
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    group_id: Annotated[uuid.UUID | None, Query(alias="group")] = None,
    site_id: Annotated[uuid.UUID | None, Query(alias="site")] = None,
    start: Annotated[date | None, Query(alias="from")] = None,
    days: Annotated[int, Query(ge=1, le=31)] = 7,
) -> TeamOut:
    """A week of the team's planned presence (FR-5.4).

    Anchor days (FR-5.8) are not here: they are P1 and would need a column on `groups`
    that nothing writes yet.
    """
    await presence_service.require_presence(session, user.organization_id)

    first = start
    if first is None:
        anchor = site_id or user.home_site_id
        if anchor is not None:
            _, first = await _site_today(session, anchor)
    if first is None:
        first = to_local_date("UTC", now_utc())

    dates = [first + timedelta(days=i) for i in range(days)]
    group, members = await presence_service.team_grid(
        session, viewer=user, group_id=group_id, dates=dates
    )
    return TeamOut(
        group_id=group.id if group else None,
        group_name=group.name if group else None,
        dates=dates,
        members=[
            TeamMemberOut(
                user_id=m.user_id,
                display_name=m.display_name,
                initials=presence_service.initials_of(m.display_name),
                avatar_url=m.avatar_url,
                is_me=m.is_me,
                days=[
                    DayPresenceOut(local_date=d.local_date, status=d.status, seat=_seat_out(d.seat))
                    for d in m.days
                ],
            )
            for m in members
        ],
    )


class AbsenceIn(BaseModel):
    kind: AbsenceKind


class AbsenceOut(BaseModel):
    local_date: date
    kind: str


# The three absence routes are deliberately NOT gated on the presence kill switch.
# An absence is the user's own record, and it also feeds assigned-desk release
# (FR-6.7), which is not a colleague-visibility feature. Switching presence off hides
# other people from you; it does not stop you telling the system you are on leave.
@router.get("/absences", response_model=list[AbsenceOut])
async def list_absences(
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
    start: Annotated[date, Query(alias="from")],
    end: Annotated[date, Query(alias="to")],
) -> list[AbsenceOut]:
    rows = await presence_service.absences_between(session, user=user, start=start, end=end)
    return [AbsenceOut(local_date=a.local_date, kind=a.kind) for a in rows]


@router.put("/absences/{local_date}", response_model=AbsenceOut)
async def declare_absence(
    local_date: date,
    body: AbsenceIn,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
) -> AbsenceOut:
    """Declare a day away without booking a desk (FR-5.5).

    Refused while a desk is still held for that day. The violation names the booking so
    the client can offer to cancel it — cancelling silently is a side effect nobody
    asked for.
    """
    absence = await presence_service.declare_absence(
        session, user=user, local_date=local_date, kind=body.kind
    )
    return AbsenceOut(local_date=absence.local_date, kind=absence.kind)


@router.delete("/absences/{local_date}", status_code=204)
async def clear_absence(
    local_date: date,
    session: Annotated[AsyncSession, Depends(db)],
    user: Annotated[User, Depends(current_user)],
) -> Response:
    await presence_service.clear_absence(session, user=user, local_date=local_date)
    # Idempotent: clearing a day that was never declared is a success, not a 404.
    return Response(status_code=204)
