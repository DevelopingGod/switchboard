"""Recompute dirty 15-minute buckets of `metrics_15m` from the raw tables (M6, ADR 0012).

Triggers append the bucket of every changed row to `metrics_dirty` (migration 0009). Each run takes a batch of
those marks, recomputes each bucket completely (delete its rows, insert fresh aggregates) and deletes exactly
the marks it read, all in one transaction under an advisory lock. Recomputing is idempotent, so running twice,
crashing mid-run or marking a bucket many times never double-counts. A run reads only the raw rows inside the
dirty buckets (index range scans on `created_at` / `finished_at`), never the whole history.

Where each number comes from:
- chat (and media) `requests` in the bucket, with their cost row (same request id) and 👍/👎;
- `costs` without a request in the bucket: jobs (agent and project through `costs.job_id`), router tasks
  (titles, summaries: `aux`), model tests and other LiteLLM clients (`external`);
- `jobs` that finished in the bucket (done / failed per agent and project).
Demo traffic (a non-empty request tag, e.g. "switchboard-demo") is kept with `demo = true` so the dashboard
can leave it out by default and include it on request.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import db
from app.metrics import hist
from app.models import Cost, Job, Message, MetricsBucket, MetricsDirty, Request

log = logging.getLogger("app.metrics.rollup")

BUCKET = timedelta(minutes=15)
LOCK_KEY = 0x5B_6D_65_74  # "sb met": one rollup at a time across workers
BATCH = 200  # buckets per run
INTERVAL_S = 60
# Skip codes that mean "tried and failed" (the rest were skipped before any call: budget, cooldown …).
ATTEMPTED = {"rate_limited", "timeout", "error", "not_found", "credit_limit"}
EPOCH = datetime(2000, 1, 1, tzinfo=UTC)


def bucket_of(ts: datetime) -> datetime:
    n = (ts - EPOCH) // BUCKET
    return EPOCH + n * BUCKET


@dataclass
class Acc:
    requests: int = 0
    ok: int = 0
    errors: int = 0
    rate_limited: int = 0
    timeouts: int = 0
    fallbacks: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    list_price_usd: float = 0.0
    unpriced: int = 0
    jobs_done: int = 0
    jobs_failed: int = 0
    thumbs_up: int = 0
    thumbs_down: int = 0
    lat_hist: list[int] = field(default_factory=hist.empty)
    ttft_hist: list[int] = field(default_factory=hist.empty)

    def add_cost(self, c: Cost | None) -> None:
        if c is None:
            return
        self.tokens_in += int(c.tokens_in or 0)
        self.tokens_out += int(c.tokens_out or 0)
        self.cost_usd += float(c.cost_usd or 0)
        if c.list_price_usd is None:
            # No list price ("cost not reported"): count what was paid, so value never drops below spend.
            self.unpriced += 1
            self.list_price_usd += float(c.cost_usd or 0)
        else:
            self.list_price_usd += float(c.list_price_usd)


Key = tuple[str, str, str, str, str, str, int, bool]  # kind provider model agent rule intent project demo


def _s(v: Any) -> str:
    return "" if v is None else str(v)


def _demo(*tags: Any) -> bool:
    return any(bool(t) for t in tags)


async def compute(session: AsyncSession, start: datetime) -> dict[Key, Acc]:
    end = start + BUCKET
    out: dict[Key, Acc] = defaultdict(Acc)

    # 1. Requests (chat, media) with their cost row and feedback.
    reqs = (
        await session.execute(
            select(Request, Cost)
            .outerjoin(Cost, (Cost.request_id == Request.id) & (Cost.source != "paperclip"))
            .where(Request.created_at >= start, Request.created_at < end)
        )
    ).all()
    ids = [r.id for r, _ in reqs]
    votes: dict[int, tuple[int, int]] = {}
    if ids:
        for rid, up, down in (
            await session.execute(
                select(
                    Message.request_id,
                    func.count().filter(Message.feedback == 1),
                    func.count().filter(Message.feedback == -1),
                )
                .where(Message.request_id.in_(ids), Message.feedback.is_not(None))
                .group_by(Message.request_id)
            )
        ).all():
            votes[rid] = (int(up), int(down))
    seen: set[int] = set()
    for r, c in reqs:
        if r.kind == "job":
            continue  # a job's own request row; its runs are counted from costs below
        tag = (r.decision_json or {}).get("tag") if isinstance(r.decision_json, dict) else None
        provider = (
            c.provider if c is not None else ((r.decision_json or {}).get("chip") or {}).get("provider")
        )
        key: Key = (
            r.kind or "chat",
            _s(provider),
            _s(c.model if c is not None else r.model),
            "",
            _s(r.rule_id),
            _s(r.intent),
            0,
            _demo(tag, c.tag if c is not None else None),
        )
        a = out[key]
        if r.id not in seen:  # a request has one router cost row; guard anyway
            seen.add(r.id)
            a.requests += 1
            if r.status == "ok":
                a.ok += 1
                hist.add(a.lat_hist, r.latency_ms)
                hist.add(a.ttft_hist, r.ttft_ms)
            elif r.status in ("error", "failed"):
                a.errors += 1
            skips = r.fallbacks_tried_json or []
            codes = [k.get("code") for k in skips if isinstance(k, dict)]
            a.rate_limited += codes.count("rate_limited")
            a.timeouts += codes.count("timeout")
            a.fallbacks += sum(1 for k in codes if k in ATTEMPTED)
            up, down = votes.get(r.id, (0, 0))
            a.thumbs_up += up
            a.thumbs_down += down
        a.add_cost(c)

    # 2. Costs without a request (jobs, router tasks, model tests, other LiteLLM clients).
    rows = (
        await session.execute(
            select(Cost, Job.agent, Job.project_id, Request.rule_id, Request.intent)
            .outerjoin(Job, Job.id == Cost.job_id)
            .outerjoin(Request, Request.id == Job.request_id)
            .where(
                Cost.created_at >= start,
                Cost.created_at < end,
                (Cost.request_id.is_(None)) | (Cost.source == "paperclip"),
            )
        )
    ).all()
    for c, agent, project_id, rule_id, intent in rows:
        kind = c.kind or ("job" if c.source == "paperclip" else "external")
        key = (
            kind,
            _s(c.provider),
            _s(c.model),
            _s(agent),
            _s(rule_id),
            _s(intent),
            int(project_id or 0),
            _demo(c.tag),
        )
        a = out[key]
        if kind != "job":
            a.requests += 1  # one LiteLLM call
            a.ok += 1
        a.add_cost(c)

    # 3. Jobs that finished in the bucket.
    for agent, project_id, status, tag, rule_id, intent, n in (
        await session.execute(
            select(
                Job.agent, Job.project_id, Job.status, Job.tag, Request.rule_id, Request.intent, func.count()
            )
            .outerjoin(Request, Request.id == Job.request_id)
            .where(Job.finished_at >= start, Job.finished_at < end, Job.status.in_(("done", "failed")))
            .group_by(Job.agent, Job.project_id, Job.status, Job.tag, Request.rule_id, Request.intent)
        )
    ).all():
        a = out[("job", "", "", _s(agent), _s(rule_id), _s(intent), int(project_id or 0), _demo(tag))]
        if status == "done":
            a.jobs_done += int(n)
        else:
            a.jobs_failed += int(n)
    return out


async def write_bucket(session: AsyncSession, start: datetime) -> int:
    accs = await compute(session, start)
    await session.execute(delete(MetricsBucket).where(MetricsBucket.bucket_start == start))
    rows = [
        {
            "bucket_start": start,
            "kind": k[0],
            "provider": k[1][:64],
            "model": k[2][:255],
            "agent": k[3][:64],
            "rule_id": k[4][:64],
            "intent": k[5][:32],
            "project_id": k[6],
            "demo": k[7],
            **{f: getattr(a, f) for f in Acc.__dataclass_fields__},
        }
        for k, a in accs.items()
    ]
    if rows:
        await session.execute(insert(MetricsBucket), rows)
    return len(rows)


async def run_once(session: AsyncSession, batch: int = BATCH) -> int:
    """Recompute up to `batch` dirty buckets; returns how many. Safe to call concurrently (one wins)."""
    got = await session.scalar(select(func.pg_try_advisory_xact_lock(LOCK_KEY)))
    if not got:
        await session.rollback()
        return 0
    marks = (
        await session.execute(
            select(MetricsDirty.id, MetricsDirty.bucket_start).order_by(MetricsDirty.id).limit(batch * 20)
        )
    ).all()
    if not marks:
        await session.rollback()
        return 0
    buckets: list[datetime] = []
    for _, b in marks:
        if b not in buckets:
            buckets.append(b)
            if len(buckets) >= batch:
                break
    chosen = set(buckets)
    for b in buckets:
        await write_bucket(session, b)
    done_ids = [i for i, b in marks if b in chosen]
    await session.execute(delete(MetricsDirty).where(MetricsDirty.id.in_(done_ids)))
    await session.commit()
    return len(buckets)


async def drain(session: AsyncSession, batch: int = BATCH) -> int:
    """Run until nothing is dirty (tests, the rebuild command)."""
    total = 0
    while n := await run_once(session, batch):
        total += n
    return total


async def mark_range(session: AsyncSession, since: datetime, until: datetime | None = None) -> int:
    """Mark every bucket with data in [since, until) dirty.

    Repair command: `python -m app.metrics.rollup --rebuild --since 2026-11-01`."""
    until = until or datetime.now(UTC) + BUCKET
    res = await session.execute(
        text(
            """
            INSERT INTO metrics_dirty(bucket_start)
            SELECT b FROM (
              SELECT date_bin('15 minutes', created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') b
                FROM costs WHERE created_at >= :s AND created_at < :u
              UNION SELECT date_bin('15 minutes', created_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')
                FROM requests WHERE created_at >= :s AND created_at < :u
              UNION SELECT date_bin('15 minutes', finished_at, TIMESTAMPTZ '2000-01-01 00:00:00+00')
                FROM jobs WHERE finished_at >= :s AND finished_at < :u
              UNION SELECT bucket_start FROM metrics_15m WHERE bucket_start >= :s AND bucket_start < :u
            ) x
            """
        ),
        {"s": since, "u": until},
    )
    await session.commit()
    return res.rowcount or 0


async def run_forever(stop: asyncio.Event | None = None) -> None:
    while not (stop and stop.is_set()):
        try:
            async with db.sessionmaker()() as session:
                await drain(session)
        except Exception:  # noqa: BLE001 - keep the loop alive; the marks stay for the next run
            log.exception("metrics rollup failed")
        await asyncio.sleep(INTERVAL_S)


async def _main() -> None:
    ap = argparse.ArgumentParser(description="Rebuild Metrics rollups for a time range.")
    ap.add_argument(
        "--rebuild", action="store_true", help="mark every bucket since --since dirty, then drain"
    )
    ap.add_argument("--since", default="2000-01-01", help="ISO date (UTC), default: all history")
    args = ap.parse_args()
    async with db.sessionmaker()() as session:
        if args.rebuild:
            since = datetime.fromisoformat(args.since).replace(tzinfo=UTC)
            print(f"marked {await mark_range(session, since)} bucket(s)")
        print(f"recomputed {await drain(session)} bucket(s)")
    await db.dispose()


if __name__ == "__main__":
    asyncio.run(_main())
