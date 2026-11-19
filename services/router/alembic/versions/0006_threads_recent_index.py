"""threads (updated_at, id) index for keyset-paginated recents (M3b)

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-19
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_threads_updated_id ON threads (updated_at DESC, id DESC)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_threads_updated_id")
