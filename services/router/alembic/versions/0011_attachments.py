"""Attachments and the Activity log (M2.5, ADRs 0016-0017)

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-22

- `attachments`: one row per attached file (chat message or job); the bytes live in the data folder.
- `requests.call_id`: the LiteLLM call id of a title/summary (`aux`) or model `test` request, which now get
  a `requests` row so the Activity log lists them. Metrics keeps counting those calls from `costs`.
- Activity search: trigram indexes on thread and job titles (pg_trgm, a trusted extension since PG 13).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("thread_id", UUID(as_uuid=True), sa.ForeignKey("threads.id", ondelete="CASCADE")),
        sa.Column("message_id", sa.BigInteger, sa.ForeignKey("messages.id", ondelete="CASCADE")),
        sa.Column("job_id", sa.BigInteger, sa.ForeignKey("jobs.id", ondelete="CASCADE")),
        sa.Column("status", sa.String(16), nullable=False, server_default="staged"),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("mime", sa.String(64), nullable=False),
        sa.Column("bytes", sa.BigInteger, nullable=False),
        sa.Column("code", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("pages", sa.Integer),
        sa.Column("pages_read", sa.Integer),
        sa.Column("width", sa.Integer),
        sa.Column("height", sa.Integer),
        sa.Column("text_chars", sa.Integer, nullable=False, server_default="0"),
        sa.Column("truncated", sa.Boolean, nullable=False, server_default="false"),
        sa.Column("secret_kinds", JSONB, nullable=False, server_default="[]"),
        sa.Column("note", sa.String(200)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_attachments_thread_id", "attachments", ["thread_id"])
    op.create_index("ix_attachments_message_id", "attachments", ["message_id"])
    op.create_index("ix_attachments_job_id", "attachments", ["job_id"])
    op.create_index("ix_attachments_status_created", "attachments", ["status", "created_at"])

    op.add_column("requests", sa.Column("call_id", sa.String(80)))
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE INDEX IF NOT EXISTS ix_threads_title_trgm ON threads USING gin (title gin_trgm_ops)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_jobs_title_trgm ON jobs USING gin (title gin_trgm_ops)")
    # Activity filters by kind and status within a time range.
    op.create_index("ix_requests_kind_created", "requests", ["kind", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_requests_kind_created", "requests")
    op.execute("DROP INDEX IF EXISTS ix_jobs_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_threads_title_trgm")
    op.drop_column("requests", "call_id")
    op.drop_table("attachments")
