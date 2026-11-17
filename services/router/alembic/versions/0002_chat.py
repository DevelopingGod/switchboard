"""chat: threads, messages; requests/costs columns for routing, decisions and free-tier value

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-17
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "threads",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("title_source", sa.String(length=16), nullable=False),
        sa.Column("private", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_threads_updated_at"), "threads", ["updated_at"])

    op.add_column("requests", sa.Column("thread_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("requests", sa.Column("intent", sa.String(length=32), nullable=True))
    op.add_column("requests", sa.Column("model", sa.String(length=255), nullable=True))
    op.add_column("requests", sa.Column("model_catalog_id", sa.Integer(), nullable=True))
    op.add_column("requests", sa.Column("ttft_ms", sa.Integer(), nullable=True))
    op.add_column("requests", sa.Column("error", sa.Text(), nullable=True))
    op.add_column(
        "requests",
        sa.Column(
            "decision_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_foreign_key(
        "requests_thread_id_fkey", "requests", "threads", ["thread_id"], ["id"], ondelete="SET NULL"
    )
    op.create_foreign_key(
        "requests_model_catalog_id_fkey",
        "requests",
        "model_catalog",
        ["model_catalog_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "messages",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("thread_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("request_id", sa.BigInteger(), nullable=True),
        sa.Column("private", sa.Boolean(), nullable=False),
        sa.Column("feedback", sa.SmallInteger(), nullable=True),
        sa.Column("meta_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["thread_id"], ["threads.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["request_id"], ["requests.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_messages_thread_id"), "messages", ["thread_id"])

    op.add_column("costs", sa.Column("list_price_usd", sa.Numeric(12, 6), nullable=True))
    op.create_index(op.f("ix_costs_created_at"), "costs", ["created_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_costs_created_at"), table_name="costs")
    op.drop_column("costs", "list_price_usd")
    op.drop_index(op.f("ix_messages_thread_id"), table_name="messages")
    op.drop_table("messages")
    op.drop_constraint("requests_model_catalog_id_fkey", "requests", type_="foreignkey")
    op.drop_constraint("requests_thread_id_fkey", "requests", type_="foreignkey")
    for col in ("decision_json", "error", "ttft_ms", "model_catalog_id", "model", "intent", "thread_id"):
        op.drop_column("requests", col)
    op.drop_index(op.f("ix_threads_updated_at"), table_name="threads")
    op.drop_table("threads")
