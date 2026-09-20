"""A photograph of the building, and the name people call the place (FR-1.9, FR-2.1).

Revision ID: 0004
Revises: 0003

Two columns and a table, for one screen: home opens on "Welcome to Tampa, Priya" over a
picture of the office you are walking into.

`short_name` exists because `sites.name` is an identifier for an admin ("Berlin HQ",
"Tampa — Rocky Point") and the greeting wants a place ("Berlin", "Tampa"). Deriving one
from the other means stripping suffixes, which is a guess that eventually greets someone
with "Welcome to Tampa — Rocky Poin". It is nullable and falls back to `name`, so a
tenant that never sets it still gets a correct, slightly formal sentence.

The photo is a separate table rather than columns on `sites` for the same reason
`floor_plan_assets` is: ingest produces a blob plus its true dimensions, and those five
facts travel together. It is deliberately NOT the same table — a floor plan carries an
`original_key`/`rendered_key` pair because a PDF is rasterized, and a building photo has
no such distinction. Widening `floor_plan_assets` to cover both would mean a column that
is meaningful for one kind of asset and always equal to its sibling for the other.

One photo per site: `sites.photo_asset_id` rather than `site_photos.site_id`, so
replacing a photo is an UPDATE of one pointer and the old row can be left for a sweep
rather than deleted inside the request that is still serving it.
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE site_photos (
            id              uuid PRIMARY KEY,
            organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            storage_key     text NOT NULL,
            width_px        integer NOT NULL,
            height_px       integer NOT NULL,
            content_type    text NOT NULL,
            checksum        text,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now()
        )
    """)

    tenant_predicate = "NULLIF(current_setting('app.org_id', true), '')::uuid"
    op.execute("ALTER TABLE site_photos ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE site_photos FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON site_photos "
        f"USING (organization_id = {tenant_predicate}) "
        f"WITH CHECK (organization_id = {tenant_predicate})"
    )

    op.execute("""
        ALTER TABLE sites
            ADD COLUMN short_name text,
            ADD COLUMN photo_asset_id uuid REFERENCES site_photos(id) ON DELETE SET NULL
    """)

    # Same guard as migrations 0001 and 0003: the runtime role does not exist on a
    # single-role database (CI, a developer's local Postgres).
    op.execute("""
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskflow_app') THEN
            EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON site_photos TO deskflow_app';
          END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE sites DROP COLUMN IF EXISTS photo_asset_id")
    op.execute("ALTER TABLE sites DROP COLUMN IF EXISTS short_name")
    op.execute("DROP TABLE IF EXISTS site_photos CASCADE")
