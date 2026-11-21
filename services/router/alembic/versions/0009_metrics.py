"""Metrics (M6, ADR 0012): 15-minute rollups, dirty-bucket triggers, costs.kind/job_id, read indexes

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-21

- `metrics_15m` holds one row per 15-minute bucket (UTC, aligned to :00/:15/:30/:45) and dimension set. 15
  minutes lines up with every UTC offset in use (+5:30, +5:45, -3:30 …), so "today" in the viewer's own time
  zone is exact. The rollup worker (app.metrics.rollup) recomputes a bucket from the raw rows whenever it is
  marked dirty.
- `metrics_dirty` is filled by triggers on every write that changes a bucket (a new cost, a request
  finishing, a job finishing, a 👍/👎), so late writes (an ingested LiteLLM log, feedback days later) are
  never missed and no writer has to remember to mark anything. It is append-only, so marking never locks.
- `costs.kind` (chat | media | job | aux | test | external) and `costs.job_id` make the merged table readable
  without guessing (job costs were joined to their agent through the job's request id).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

BUCKET = "date_bin('15 minutes', {ts}, TIMESTAMPTZ '2000-01-01 00:00:00+00')"

TRIGGERS = {
    # table: (timestamp that picks the bucket, condition); {r} is NEW or OLD
    "costs": ("{r}.created_at", "TRUE"),
    "requests": ("{r}.created_at", "TRUE"),
    "jobs": ("{r}.finished_at", "{r}.status IN ('done', 'failed') AND {r}.finished_at IS NOT NULL"),
}


def upgrade() -> None:
    op.add_column("costs", sa.Column("kind", sa.String(16)))
    op.add_column("costs", sa.Column("job_id", sa.BigInteger, sa.ForeignKey("jobs.id", ondelete="SET NULL")))
    op.create_index("ix_costs_request_id", "costs", ["request_id"])
    op.create_index("ix_costs_job_id", "costs", ["job_id"])
    # Backfill: job costs via the run id in job_events (works for jobs without a request), then by request.
    op.execute(
        """
        UPDATE costs c SET job_id = e.job_id
        FROM job_events e
        WHERE c.source = 'paperclip' AND e.kind = 'run_finished'
          AND c.external_id = 'paperclip-run:' || (e.data->>'run')
        """
    )
    op.execute(
        """
        UPDATE costs c SET job_id = j.id
        FROM jobs j
        WHERE c.source = 'paperclip' AND c.job_id IS NULL AND c.request_id IS NOT NULL
          AND j.request_id = c.request_id
        """
    )
    op.execute(
        """
        UPDATE costs c SET kind = CASE
            WHEN c.source = 'paperclip' THEN 'job'
            WHEN c.request_id IS NOT NULL
              THEN COALESCE((SELECT r.kind FROM requests r WHERE r.id = c.request_id), 'chat')
            ELSE 'external' END
        """
    )

    op.create_index("ix_requests_created_id", "requests", [sa.text("created_at DESC"), sa.text("id DESC")])
    op.create_index("ix_jobs_finished_at", "jobs", ["finished_at"])
    op.create_index(
        "ix_messages_feedback_request",
        "messages",
        ["request_id"],
        postgresql_where=sa.text("feedback IS NOT NULL"),
    )

    op.create_table(
        "metrics_15m",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("bucket_start", sa.DateTime(timezone=True), nullable=False),
        # Dimensions ('' = none, so the unique key needs no NULL handling).
        sa.Column("kind", sa.String(16), nullable=False),  # chat | media | job | aux | test | external
        sa.Column("provider", sa.String(64), nullable=False, server_default=""),
        sa.Column("model", sa.String(255), nullable=False, server_default=""),
        sa.Column("agent", sa.String(64), nullable=False, server_default=""),
        sa.Column("rule_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("intent", sa.String(32), nullable=False, server_default=""),
        sa.Column("project_id", sa.Integer, nullable=False, server_default="0"),
        sa.Column("demo", sa.Boolean, nullable=False, server_default=sa.false()),
        # Measures.
        sa.Column("requests", sa.Integer, nullable=False, server_default="0"),
        sa.Column("ok", sa.Integer, nullable=False, server_default="0"),
        sa.Column("errors", sa.Integer, nullable=False, server_default="0"),
        sa.Column("rate_limited", sa.Integer, nullable=False, server_default="0"),
        sa.Column("timeouts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("fallbacks", sa.Integer, nullable=False, server_default="0"),
        sa.Column("tokens_in", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(14, 6), nullable=False, server_default="0"),
        sa.Column("list_price_usd", sa.Numeric(14, 6), nullable=False, server_default="0"),
        sa.Column("unpriced", sa.Integer, nullable=False, server_default="0"),  # rows with no list price
        sa.Column("jobs_done", sa.Integer, nullable=False, server_default="0"),
        sa.Column("jobs_failed", sa.Integer, nullable=False, server_default="0"),
        sa.Column("thumbs_up", sa.Integer, nullable=False, server_default="0"),
        sa.Column("thumbs_down", sa.Integer, nullable=False, server_default="0"),
        sa.Column("lat_hist", ARRAY(sa.Integer), nullable=False, server_default="{}"),
        sa.Column("ttft_hist", ARRAY(sa.Integer), nullable=False, server_default="{}"),
        sa.UniqueConstraint(
            "bucket_start",
            "kind",
            "provider",
            "model",
            "agent",
            "rule_id",
            "intent",
            "project_id",
            "demo",
            name="uq_metrics_15m_dims",
        ),
    )
    op.create_index("ix_metrics_15m_bucket", "metrics_15m", ["bucket_start"])

    # Append-only and lock-free: a write never waits on another (no upsert, no row lock), and the rollup
    # deletes exactly the ids it read, so a mark committed while it runs stays for the next run.
    op.create_table(
        "metrics_dirty",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("bucket_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("marked_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # Both sides of a change: the old bucket (an update that moves a row, or a delete) and the new one.
    for table, (ts, cond) in TRIGGERS.items():
        new_b, old_b = BUCKET.format(ts=ts.format(r="NEW")), BUCKET.format(ts=ts.format(r="OLD"))
        op.execute(
            f"""
            CREATE FUNCTION metrics_mark_{table}() RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE nb timestamptz;
            BEGIN
              IF TG_OP <> 'DELETE' AND {cond.format(r="NEW")} THEN
                nb := {new_b};
                INSERT INTO metrics_dirty(bucket_start) VALUES (nb);
              END IF;
              IF TG_OP <> 'INSERT' AND {cond.format(r="OLD")} AND {old_b} IS DISTINCT FROM nb THEN
                INSERT INTO metrics_dirty(bucket_start) VALUES ({old_b});
              END IF;
              RETURN NULL;
            END $$;
            CREATE TRIGGER metrics_mark AFTER INSERT OR UPDATE OR DELETE ON {table}
              FOR EACH ROW EXECUTE FUNCTION metrics_mark_{table}();
            """
        )
    # 👍/👎 lands in the bucket of the request it rates.
    op.execute(
        f"""
        CREATE FUNCTION metrics_mark_messages() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.request_id IS NOT NULL THEN
            INSERT INTO metrics_dirty(bucket_start)
              SELECT {BUCKET.format(ts="r.created_at")} FROM requests r WHERE r.id = NEW.request_id;
          END IF;
          RETURN NULL;
        END $$;
        CREATE TRIGGER metrics_mark AFTER UPDATE OF feedback ON messages
          FOR EACH ROW WHEN (NEW.feedback IS DISTINCT FROM OLD.feedback)
          EXECUTE FUNCTION metrics_mark_messages();
        """
    )
    # Existing history: every bucket with data is dirty once, so the first rollup run fills the table.
    op.execute(
        f"""
        INSERT INTO metrics_dirty(bucket_start)
        SELECT DISTINCT {BUCKET.format(ts="created_at")} FROM costs
        UNION SELECT DISTINCT {BUCKET.format(ts="created_at")} FROM requests
        UNION SELECT DISTINCT {BUCKET.format(ts="finished_at")} FROM jobs WHERE finished_at IS NOT NULL
        """
    )


def downgrade() -> None:
    for table in ("costs", "requests", "jobs", "messages"):
        op.execute(f"DROP TRIGGER IF EXISTS metrics_mark ON {table}")
        op.execute(f"DROP FUNCTION IF EXISTS metrics_mark_{table}()")
    op.drop_table("metrics_dirty")
    op.drop_index("ix_metrics_15m_bucket", table_name="metrics_15m")
    op.drop_table("metrics_15m")
    op.drop_index("ix_messages_feedback_request", table_name="messages")
    op.drop_index("ix_jobs_finished_at", table_name="jobs")
    op.drop_index("ix_requests_created_id", table_name="requests")
    op.drop_index("ix_costs_job_id", table_name="costs")
    op.drop_index("ix_costs_request_id", table_name="costs")
    op.drop_column("costs", "job_id")
    op.drop_column("costs", "kind")
