"""threads.pinned (M1.5: pin threads in the sidebar)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("threads", sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("threads", "pinned")
