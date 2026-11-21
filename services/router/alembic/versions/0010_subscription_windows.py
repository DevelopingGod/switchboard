"""Subscription windows (M6.5, ADRs 0013-0015): named CLI accounts, usage windows, jobs that wait for resets

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-21

- `cli_accounts`: the named accounts of a subscription CLI (the folder lives on the host, managed by the
  vendor CLI; "default" is implicit and never stored). Soft delete keeps old jobs readable.
- `usage_windows`: the latest reading of each usage window per CLI and account (one row per window, so it
  never grows): reported by the CLI, or estimated from our own runs (`capacity` is the calibration).
- `agent_profiles.account`, `projects.accounts` ({cli: account}): who uses which account (project wins).
- `jobs.account` (fixed when the job is created: a job never moves to another account of the same CLI),
  `resume_at`, `attempt`, `waits`, `paid`, and the job's routing rule (`rule_id`, for "light work").
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cli_accounts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("cli", sa.String(16), nullable=False),
        sa.Column("name", sa.String(32), nullable=False),
        sa.Column("label", sa.String(80)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("cli", "name", name="uq_cli_accounts_cli_name"),
    )
    op.create_table(
        "usage_windows",
        sa.Column("cli", sa.String(16), primary_key=True),
        sa.Column("account", sa.String(32), primary_key=True),
        sa.Column("window", sa.String(32), primary_key=True),
        sa.Column("used", sa.Float),  # 0..1; null = unknown
        sa.Column("resets_at", sa.DateTime(timezone=True)),
        sa.Column("limited", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("source", sa.String(16), nullable=False),  # reported | estimate
        sa.Column("capacity", sa.Float),  # our own consumption units that fill the window (calibration)
        sa.Column("hours", sa.Float),  # the window's length as reported (Codex) or configured
        sa.Column("seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.add_column("agent_profiles", sa.Column("account", sa.String(32)))
    op.add_column("projects", sa.Column("accounts", JSONB))
    op.add_column("jobs", sa.Column("account", sa.String(32)))
    op.add_column("jobs", sa.Column("rule_id", sa.String(64)))
    op.add_column("jobs", sa.Column("resume_at", sa.DateTime(timezone=True)))
    op.add_column("jobs", sa.Column("attempt", sa.SmallInteger, nullable=False, server_default="0"))
    op.add_column("jobs", sa.Column("waits", sa.SmallInteger, nullable=False, server_default="0"))
    op.add_column("jobs", sa.Column("paid", sa.Boolean, nullable=False, server_default=sa.false()))
    op.add_column("jobs", sa.Column("paid_budget_usd", sa.Numeric(10, 4)))
    op.create_index("ix_jobs_status_resume_at", "jobs", ["status", "resume_at"])


def downgrade() -> None:
    op.drop_index("ix_jobs_status_resume_at", table_name="jobs")
    for col in ("paid_budget_usd", "paid", "waits", "attempt", "resume_at", "rule_id", "account"):
        op.drop_column("jobs", col)
    op.drop_column("projects", "accounts")
    op.drop_column("agent_profiles", "account")
    op.drop_table("usage_windows")
    op.drop_table("cli_accounts")
