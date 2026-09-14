from fastapi import APIRouter

from app.api.v1 import admin, admin_people, auth, bookings, me, plans, presence, spaces

api_router = APIRouter(prefix="/v1")
api_router.include_router(auth.router)
api_router.include_router(me.router)
api_router.include_router(spaces.router)
api_router.include_router(bookings.router)
api_router.include_router(presence.router)
api_router.include_router(plans.router)
api_router.include_router(admin.router)
# Users, groups and roles (FR-8.4). Same prefix and role gate, separate concern.
api_router.include_router(admin_people.router)
