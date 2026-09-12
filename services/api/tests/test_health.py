import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.fixture
async def client():
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


async def test_ready_checks_database(client):
    r = await client.get("/health/ready")
    assert r.status_code == 200 and r.json()["database"] == "ok"


async def test_unauthenticated_request_returns_problem_json(client):
    r = await client.get("/v1/sites")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["title"] == "Authentication required"


async def test_openapi_is_generated(client):
    r = await client.get("/openapi.json")
    assert r.status_code == 200
    assert "/v1/sites" in r.json()["paths"]
    assert "/v1/auth/dev-login" not in r.json()["paths"], "dev login must not be in the contract"
