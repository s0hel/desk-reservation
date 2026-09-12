import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.v1 import health
from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.errors import ProblemError, problem_handler
from app.core.logging import configure_logging
from app.db.session import engine

settings = get_settings()
log = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level)
    settings.assert_safe()
    log.info("api.startup", environment=settings.environment, dev_login=settings.enable_dev_login)
    yield
    log.info("api.shutdown")


async def assert_rls_enforceable() -> None:
    """Refuse to serve traffic as a role that bypasses row level security.

    RLS is the tenant boundary (TDD §18.2), and a superuser or BYPASSRLS role ignores it
    even with FORCE set — silently, with every policy still listed on every table. The
    check costs one query at startup and turns a catastrophic misconfiguration into a
    failed boot.
    """
    async with engine.connect() as conn:
        role = (await conn.execute(text("SELECT current_user"))).scalar_one()
        superuser = (
            await conn.execute(text("SELECT current_setting('is_superuser')"))
        ).scalar_one()
        bypass = (
            await conn.execute(
                text("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
            )
        ).scalar_one()

    if superuser == "on" or bypass:
        message = (
            f"database role '{role}' bypasses row level security "
            f"(superuser={superuser}, bypassrls={bypass}); tenant isolation would not be "
            f"enforced. Use the non-superuser application role."
        )
        if settings.environment == "development":
            log.warning("rls.not_enforced", role=role, detail=message)
        else:
            raise RuntimeError(message)


app = FastAPI(
    title="Deskflow API",
    version="0.1.0",
    description="Flex workspace booking. See docs/TECHNICAL_DESIGN.md.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    structlog.contextvars.bind_contextvars(request_id=request_id, path=request.url.path)
    try:
        response = await call_next(request)
    finally:
        structlog.contextvars.clear_contextvars()
    response.headers["x-request-id"] = request_id
    return response


app.add_exception_handler(ProblemError, problem_handler)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Validation errors use the same problem+json shape as everything else, so the
    client has exactly one error contract to handle (TDD §11)."""
    return JSONResponse(
        {
            "type": f"{str(request.base_url).rstrip('/')}/errors/validation",
            "title": "Invalid request",
            "status": 422,
            "detail": "Request body or parameters failed validation",
            "violations": [
                {
                    "code": "validation." + e.get("type", "invalid"),
                    "params": {"field": ".".join(str(p) for p in e.get("loc", []))},
                    "severity": "block",
                }
                for e in exc.errors()
            ],
        },
        status_code=422,
        media_type="application/problem+json",
    )


app.include_router(health.router)
app.include_router(api_router)
