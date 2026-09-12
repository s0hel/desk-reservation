"""Tenant isolation is structural (TDD §18.2). If these fail, nothing else matters."""

import uuid

from sqlalchemy import text


async def test_org_b_cannot_see_org_a_rows(org_a, org_b, session_for):
    async with session_for(org_a) as s:
        await s.execute(
            text("""INSERT INTO sites (id, organization_id, name, timezone)
                    VALUES (:i, :o, 'Secret Site', 'Europe/Berlin')"""),
            {"i": uuid.uuid4(), "o": org_a},
        )

    async with session_for(org_b) as s:
        rows = (await s.execute(text("SELECT name FROM sites"))).all()
    assert rows == [], "tenant B read tenant A's site"


async def test_no_tenant_context_yields_no_rows(org_a, session_for):
    async with session_for(org_a) as s:
        await s.execute(
            text("""INSERT INTO sites (id, organization_id, name, timezone)
                    VALUES (:i, :o, 'Berlin', 'Europe/Berlin')"""),
            {"i": uuid.uuid4(), "o": org_a},
        )

    from app.db.session import SessionFactory

    async with SessionFactory() as s:
        await s.begin()
        rows = (await s.execute(text("SELECT * FROM sites"))).all()
        await s.rollback()
    assert rows == [], "unset app.org_id must return nothing, not everything"


async def test_cannot_insert_into_another_tenant(org_a, org_b, session_for):
    """WITH CHECK must stop a forged organization_id, not just filter reads."""
    import asyncpg

    raised = False
    try:
        async with session_for(org_a) as s:
            await s.execute(
                text("""INSERT INTO sites (id, organization_id, name, timezone)
                        VALUES (:i, :o, 'Smuggled', 'Europe/Berlin')"""),
                {"i": uuid.uuid4(), "o": org_b},  # org_b while bound to org_a
            )
    except Exception as exc:  # RLS violation
        raised = True
        assert "row-level security" in str(exc).lower() or isinstance(
            exc.__cause__, asyncpg.exceptions.InsufficientPrivilegeError
        )
    assert raised, "RLS WITH CHECK did not block a cross-tenant insert"


async def test_every_org_scoped_table_has_rls_enabled(org_a, session_for):
    """Guards against a new table being added without RLS — the failure mode that
    would silently un-isolate one table while everything else looks fine."""
    async with session_for(org_a) as s:
        rows = (
            await s.execute(
                text("""
                    SELECT c.relname
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind = 'r'
                      AND c.relname NOT IN ('alembic_version')
                      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
                """)
            )
        ).all()
    assert rows == [], f"tables without FORCEd RLS: {[r[0] for r in rows]}"
