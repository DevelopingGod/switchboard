"""agent_profiles (fleet overlay, ADR 0009); keyset indexes for the job board filters (M4b)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-20
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One row per hired agent, or per edited built-in agent (config/agents.yaml stays the base; ADR 0009).
    op.create_table(
        "agent_profiles",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("template", sa.String(64), nullable=False),  # the agents.yaml entry it is built on
        sa.Column("builtin", sa.Boolean, nullable=False, server_default=sa.false()),  # edits a yaml agent
        sa.Column("label", sa.String(80)),
        sa.Column("role", sa.Text),
        sa.Column("model", sa.String(120)),
        sa.Column("default_autonomy", sa.SmallInteger),
        sa.Column("monthly_list_usd", sa.Numeric(10, 2)),
        sa.Column("allowed_project_ids", JSONB),  # null = every project
        sa.Column("paused", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),  # soft delete: jobs and costs keep their agent
    )
    # The board pages newest first (by id) within a status, an agent or a project.
    op.create_index("ix_jobs_status_id", "jobs", ["status", sa.text("id DESC")])
    op.create_index("ix_jobs_agent_id", "jobs", ["agent", sa.text("id DESC")])
    op.create_index("ix_jobs_project_id_id", "jobs", ["project_id", sa.text("id DESC")])
    op.drop_index("ix_jobs_project", table_name="jobs")


def downgrade() -> None:
    op.create_index("ix_jobs_project", "jobs", ["project_id"])
    op.drop_index("ix_jobs_project_id_id", table_name="jobs")
    op.drop_index("ix_jobs_agent_id", table_name="jobs")
    op.drop_index("ix_jobs_status_id", table_name="jobs")
    op.drop_table("agent_profiles")
