"""rules_versions: Rules UI overrides with history (M3b, ADR 0004)

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-19
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rules_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(16), nullable=False, server_default="edit"),
        sa.Column("note", sa.String(200)),
        sa.Column("rolled_back_to", sa.Integer()),
        sa.Column("base_sha", sa.String(64), nullable=False, server_default=""),
        sa.Column("overrides", postgresql.JSONB(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("rules_versions")
