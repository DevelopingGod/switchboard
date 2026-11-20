"""jobs, job_events, projects; costs.external_id and costs.tag (M4a)

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-20
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("costs", sa.Column("external_id", sa.String(128), nullable=True))
    op.add_column("costs", sa.Column("tag", sa.String(64), nullable=True))
    op.create_unique_constraint("uq_costs_external_id", "costs", ["external_id"])
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("path", sa.Text, nullable=False, unique=True),
        sa.Column("slug", sa.String(80), nullable=False, unique=True),
        sa.Column("head_branch", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("removed_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("request_id", sa.BigInteger, sa.ForeignKey("requests.id", ondelete="SET NULL")),
        sa.Column(
            "project_id", sa.Integer, sa.ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False
        ),
        sa.Column("title", sa.String(240), nullable=False),
        sa.Column("prompt", sa.Text, nullable=False),
        sa.Column("agent", sa.String(64), nullable=False),
        sa.Column("agent_chain", JSONB, nullable=False, server_default="[]"),
        sa.Column("autonomy", sa.SmallInteger, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("phase", sa.String(16)),
        sa.Column("run_index", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("gate", sa.String(16)),
        sa.Column("paperclip_issue_id", sa.String(64)),
        sa.Column("paperclip_agent_id", sa.String(64)),
        sa.Column("paperclip_approval_id", sa.String(64)),
        sa.Column("current_run_id", sa.String(64)),
        sa.Column("log_offset", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("worktree_path", sa.Text),
        sa.Column("branch", sa.String(255)),
        sa.Column("base_sha", sa.String(64)),
        sa.Column("worktree_removed", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("budget_list_usd", sa.Numeric(10, 4), nullable=False),
        sa.Column("list_price_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("cost_reported", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("turns", sa.Integer, nullable=False, server_default="0"),
        sa.Column("plan_text", sa.Text),
        sa.Column("result_text", sa.Text),
        sa.Column("error", sa.Text),
        sa.Column("tag", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # Lists are newest first and filtered by status; the job loop reads the active ones per agent.
    op.create_index("ix_jobs_created_id", "jobs", [sa.text("created_at DESC"), sa.text("id DESC")])
    op.create_index("ix_jobs_status_created", "jobs", ["status", "created_at"])
    op.create_index("ix_jobs_agent_status", "jobs", ["agent", "status"])
    op.create_index("ix_jobs_project", "jobs", ["project_id"])
    op.create_table(
        "job_events",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("job_id", sa.BigInteger, sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("data", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_job_events_job_id", "job_events", ["job_id", "id"])


def downgrade() -> None:
    op.drop_table("job_events")
    op.drop_table("jobs")
    op.drop_table("projects")
    op.drop_constraint("uq_costs_external_id", "costs", type_="unique")
    op.drop_column("costs", "tag")
    op.drop_column("costs", "external_id")
