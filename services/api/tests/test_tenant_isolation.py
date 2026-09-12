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


async def test_connection_role_cannot_bypass_rls(org_a, session_for):
    """The precondition every other isolation test depends on.

    A superuser (or a BYPASSRLS role) ignores row level security even when every table
    has FORCE set. If the API connects as one, the policies are decorative and the rest
    of this file passes while isolating nothing. Assert the precondition explicitly so
    that misconfiguration fails loudly here instead of quietly in production.
    """
    async with session_for(org_a) as s:
        is_superuser = await s.scalar(text("SELECT current_setting('is_superuser')"))
        bypass = await s.scalar(
            text("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
        )
        role = await s.scalar(text("SELECT current_user"))

    assert is_superuser == "off", (
        f"connected as superuser '{role}' — RLS is not enforced. "
        f"Point DATABASE_URL at the non-superuser application role."
    )
    assert bypass is False, f"role '{role}' has BYPASSRLS — RLS is not enforced"
