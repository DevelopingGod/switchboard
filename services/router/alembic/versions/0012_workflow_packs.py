"""Workflow packs (M4.5a, ADRs 0018-0019)

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-23

- `projects.packs`: per-project pack settings and graphify's measuring state.
- `jobs.flow` (a pack workflow such as "openspec.change") and `jobs.packs` (what the job's packs did).
- `costs.tokens_cached`: cached input tokens; a job's tokens are input + cached + output.
- `pack_installs`: every install, rollback and removal of a pack, with the plan the owner read.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("packs", JSONB))
    op.add_column("jobs", sa.Column("flow", sa.String(64)))
    op.add_column("jobs", sa.Column("packs", JSONB))
    op.add_column("costs", sa.Column("tokens_cached", sa.Integer))
    op.create_table(
        "pack_installs",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("pack", sa.String(64), nullable=False),
        sa.Column("version", sa.String(64)),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("summary_json", JSONB, nullable=False, server_default="{}"),
        sa.Column("log_tail", sa.Text),
        sa.Column("hostprobe_job", sa.String(32)),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_pack_installs_pack", "pack_installs", ["pack"])
    # graphify's samples: finished jobs of one project + agent, newest first.
    op.create_index("ix_jobs_project_agent_finished", "jobs", ["project_id", "agent", "finished_at"])


def downgrade() -> None:
    op.drop_index("ix_jobs_project_agent_finished", "jobs")
    op.drop_index("ix_pack_installs_pack", "pack_installs")
    op.drop_table("pack_installs")
    op.drop_column("costs", "tokens_cached")
    op.drop_column("jobs", "packs")
    op.drop_column("jobs", "flow")
    op.drop_column("projects", "packs")
