from fastapi import APIRouter

from app.api.v1 import auth, bookings, me, spaces

api_router = APIRouter(prefix="/v1")
api_router.include_router(auth.router)
api_router.include_router(me.router)
api_router.include_router(spaces.router)
api_router.include_router(bookings.router)
