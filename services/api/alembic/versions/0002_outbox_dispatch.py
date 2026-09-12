"""Outbox dispatch queue — makes the worker possible without weakening RLS.

Revision ID: 0002
Revises: 0001

The outbox (TDD §15.1) is tenant data and lives under row level security, which means a
worker draining it across tenants cannot see anything: with no app.org_id bound, every
row is invisible. The obvious fix — give the worker BYPASSRLS — would hand a background
process unrestricted access to every tenant's data, which is precisely the boundary the
whole design rests on.

So routing is separated from content. `outbox_dispatch` holds only identifiers and
scheduling state — never payloads, never anything about a person — and is deliberately
NOT under RLS. The worker reads it to learn *that* tenant X has work and *which* row,
then binds that tenant and reads the payload under RLS like any other caller.

This is the same reasoning as the `domain_routing` policy on org_domains: a routing
index may be global precisely because it carries no tenant content.

A trigger keeps the two in lockstep, so the dispatch row is created in the same
transaction as the outbox row and the pair cannot diverge.
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE outbox_dispatch (
            outbox_id       uuid PRIMARY KEY REFERENCES outbox(id) ON DELETE CASCADE,
            organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            available_at    timestamptz NOT NULL DEFAULT now(),
            attempts        integer NOT NULL DEFAULT 0,
            locked_until    timestamptz,
            processed_at    timestamptz,
            failed_at       timestamptz,
            last_error      text,
            created_at      timestamptz NOT NULL DEFAULT now()
        )
    """)
    # The claim path: pending, due, unlocked, oldest first.
    op.execute("""
        CREATE INDEX outbox_dispatch_claimable ON outbox_dispatch (available_at)
          WHERE processed_at IS NULL AND failed_at IS NULL
    """)
    op.execute("""
        CREATE INDEX outbox_dispatch_dead_letter ON outbox_dispatch (failed_at)
          WHERE failed_at IS NOT NULL
    """)

    op.execute("""
        CREATE FUNCTION outbox_enqueue_dispatch() RETURNS trigger AS $fn$
        BEGIN
          INSERT INTO outbox_dispatch (outbox_id, organization_id, available_at)
          VALUES (NEW.id, NEW.organization_id, NEW.available_at);
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql
    """)
    op.execute("""
        CREATE TRIGGER outbox_dispatch_insert AFTER INSERT ON outbox
          FOR EACH ROW EXECUTE FUNCTION outbox_enqueue_dispatch()
    """)

    # Backfill anything already queued before this migration.
    op.execute("""
        INSERT INTO outbox_dispatch (outbox_id, organization_id, available_at)
        SELECT id, organization_id, available_at FROM outbox
        ON CONFLICT (outbox_id) DO NOTHING
    """)

    # Scheduling state now lives in exactly one place. Duplicated mutable state across
    # two tables is the kind of thing that silently diverges.
    op.execute("""
        ALTER TABLE outbox
          DROP COLUMN attempts,
          DROP COLUMN locked_until,
          DROP COLUMN processed_at,
          DROP COLUMN last_error
    """)

    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskflow_app') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_dispatch TO deskflow_app';
          END IF;
        END $$
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS outbox_dispatch_insert ON outbox")
    op.execute("DROP FUNCTION IF EXISTS outbox_enqueue_dispatch()")
    op.execute("DROP TABLE IF EXISTS outbox_dispatch")
    op.execute("""
        ALTER TABLE outbox
          ADD COLUMN attempts integer NOT NULL DEFAULT 0,
          ADD COLUMN locked_until timestamptz,
          ADD COLUMN processed_at timestamptz,
          ADD COLUMN last_error text
    """)
