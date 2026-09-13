"""Floor layout drafts — edits that employees cannot see yet (TDD §14.3).

Revision ID: 0003
Revises: 0002

The editor needs "draft vs published state per floor: edits are invisible to employees
until published". The obvious implementation — a status column on resources and zones —
does not actually work: moving an existing desk is not a new row, it is a pending
*change* to a published one, and there is nowhere on the live row to hold a position
that is not yet in effect without duplicating every editable column.

So a draft is a document, not a set of rows. `floor_drafts.layout` holds the whole
intended layout of one floor as JSON; live `resources` and `zones` continue to be the
only thing availability reads, so an unpublished edit is invisible by construction
rather than by everyone remembering to filter. Publishing diffs the document against
the live rows and applies creates, updates and deletes in one transaction.

That also matches how the editor behaves: undo/redo over a local command stack with an
explicit batched save is a document editor, and a document is what it should be saving.

One draft per floor (UNIQUE on floor_id): concurrent editing of the same floor by two
admins is a Phase 3 problem, and `base_version` is here so that when it arrives the
answer is a conflict rather than a silent overwrite.
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE floor_drafts (
            id                 uuid PRIMARY KEY,
            organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            floor_id           uuid NOT NULL UNIQUE REFERENCES floors(id) ON DELETE CASCADE,
            layout             jsonb NOT NULL,
            base_version       integer NOT NULL DEFAULT 0,
            updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
            created_at         timestamptz NOT NULL DEFAULT now(),
            updated_at         timestamptz NOT NULL DEFAULT now()
        )
    """)

    tenant_predicate = "NULLIF(current_setting('app.org_id', true), '')::uuid"
    op.execute("ALTER TABLE floor_drafts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE floor_drafts FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON floor_drafts "
        f"USING (organization_id = {tenant_predicate}) "
        f"WITH CHECK (organization_id = {tenant_predicate})"
    )

    # Same guard as migration 0001: the runtime role does not exist on a single-role
    # database (CI, a developer's local Postgres).
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskflow_app') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON floor_drafts TO deskflow_app';
          END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS floor_drafts CASCADE")
