"""M3a routing brain: quota counters, persisted cooldowns, rate-limit header snapshots, thread summaries
and the reason a thread is private.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-18
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "quota_usage",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("scope_key", sa.String(255), nullable=False),
        sa.Column("window", sa.String(1), nullable=False),  # m | d
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("requests", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("provider", "scope_key", "window", "window_start", name="uq_quota_bucket"),
    )
    op.create_index("ix_quota_usage_window_start", "quota_usage", ["window_start"])
    op.create_table(
        "cooldowns",
        sa.Column("target", sa.String(255), primary_key=True),
        sa.Column("provider", sa.String(64)),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("until", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "quota_headers",
        sa.Column("provider", sa.String(64), primary_key=True),
        sa.Column("scope_key", sa.String(255), primary_key=True),
        sa.Column("data", JSONB(), nullable=False, server_default="{}"),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.add_column("threads", sa.Column("summary_json", JSONB()))
    op.add_column("threads", sa.Column("private_source", sa.String(16)))
    op.execute("UPDATE threads SET private_source = 'user' WHERE private")


def downgrade() -> None:
    op.drop_column("threads", "private_source")
    op.drop_column("threads", "summary_json")
    op.drop_table("quota_headers")
    op.drop_table("cooldowns")
    op.drop_index("ix_quota_usage_window_start", table_name="quota_usage")
    op.drop_table("quota_usage")
