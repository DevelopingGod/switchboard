"""The Activity log (M2.5, ADR 0017): one list of every request the router made, newest first.

Chats, jobs, titles and summaries (`aux`), model tests (`test`), and media later, all from `requests`, keyset
paged on (created_at, id) (index `ix_requests_created_id`), so page 1,000 costs what page 1 does. Each row's
cost comes from `costs`: by request id, by the LiteLLM call id for titles and tests (their cost rows are
written by the spend-log ingester), or by job id for agent runs.

Privacy: labels only, never message text. A private chat (and its titles and summaries) is "Private chat";
titles are secret-masked; a title search never matches a private chat's title.
"""

from __future__ import annotations

import base64
import csv
import io
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import secrets
from app.metrics.queries import PRIVATE_LABEL, safe_title
from app.metrics.ranges import Range

KINDS = ("chat", "media", "job", "aux", "test")
# Requests: ok … running. Jobs show their own state (the job's request row is written once, at creation).
STATUSES = (
    "ok",
    "error",
    "failed",
    "stopped",
    "blocked",
    "unavailable",
    "running",
    "queued",
    "needs_approval",
    "waiting_reset",
    "done",
)
ATTEMPTED = ("rate_limited", "timeout", "error", "not_found", "credit_limit")
CSV_MAX_ROWS = 50_000
PAGE = 50


@dataclass(frozen=True)
class Filters:
    kinds: tuple[str, ...] = ()
    model: str | None = None
    provider: str | None = None
    rule: str | None = None
    status: str | None = None
    q: str | None = None
    include_demo: bool = False


# Derived columns, computed once per row in a LATERAL so filters and output agree.
_SQL = """
SELECT r.id, r.created_at, r.kind, d.status, r.rule_id, r.private, r.latency_ms, r.thread_id,
       r.fallbacks_tried_json AS skips, r.decision_json ->> 'purpose' AS purpose,
       t.title AS thread_title, COALESCE(t.private, false) AS thread_private,
       j.id AS job_id, j.title AS job_title,
       d.provider, d.model, c.cost_usd, c.value_usd, c.priced
FROM requests r
LEFT JOIN threads t ON t.id = r.thread_id
LEFT JOIN jobs j ON r.kind = 'job' AND j.request_id = r.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(x.cost_usd), 0) AS cost_usd,
           COALESCE(SUM(x.list_price_usd), 0) AS value_usd,
           COUNT(x.id) AS priced,
           MIN(x.provider) AS provider,
           MIN(x.model) AS model
    FROM costs x
    WHERE (x.request_id = r.id AND x.source <> 'paperclip')
       OR (r.call_id IS NOT NULL AND x.external_id = 'litellm:' || r.call_id)
       OR (j.id IS NOT NULL AND x.job_id = j.id)
) c ON true
CROSS JOIN LATERAL (
    SELECT COALESCE(
               NULLIF(c.provider, ''),
               r.decision_json -> 'chip' ->> 'provider',
               NULLIF(split_part(r.model, '/', 1), r.model)
           ) AS provider,
           COALESCE(r.model, c.model, r.target) AS model,
           COALESCE(j.status, r.status) AS status
) d
WHERE r.created_at >= :s AND r.created_at < :e
"""


def _where(f: Filters, params: dict[str, Any]) -> str:
    out = []
    if not f.include_demo:
        out.append("COALESCE(r.decision_json ->> 'tag', '') = ''")
    if f.kinds:
        out.append("r.kind = ANY(:kinds)")
        params["kinds"] = list(f.kinds)
    if f.model:
        out.append("d.model = :model")
        params["model"] = f.model
    if f.provider:
        out.append("d.provider = :provider")
        params["provider"] = f.provider
    if f.rule:
        out.append("r.rule_id = :rule")
        params["rule"] = f.rule
    if f.status:
        out.append("d.status = :status")
        params["status"] = f.status
    if f.q:
        # Titles only, and never a private chat's (trigram indexes on threads.title and jobs.title).
        out.append(
            "((t.title ILIKE :q AND NOT COALESCE(t.private, false) AND NOT r.private) OR j.title ILIKE :q)"
        )
        params["q"] = "%" + f.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return "".join(f" AND {w}" for w in out)


def encode_cursor(created_at: datetime, rid: int) -> str:
    raw = json.dumps({"t": created_at.isoformat(), "id": rid}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[datetime, int] | None:
    if not cursor:
        return None
    try:
        pad = "=" * (-len(cursor) % 4)
        d = json.loads(base64.urlsafe_b64decode((cursor + pad).encode()))
        return datetime.fromisoformat(d["t"]), int(d["id"])
    except (ValueError, KeyError, TypeError):
        return None


def label(row: Any) -> str:
    private = bool(row.private or row.thread_private)
    if row.kind == "job":
        return secrets.redact(" ".join((row.job_title or "").split()))[:120] or "Job"
    if row.kind == "test":
        return f"Model test: {row.model or 'model'}"
    if row.kind == "aux":
        what = "Summary" if row.purpose == "summary" else "Title"
        if row.thread_id is None:
            return what
        return f"{what} · {PRIVATE_LABEL if private else safe_title(row.thread_title, False)}"
    if row.thread_id is None and not private:
        return "Chat"
    return safe_title(row.thread_title, private)


def as_dict(row: Any) -> dict[str, Any]:
    skips = row.skips if isinstance(row.skips, list) else []
    return {
        "id": row.id,
        "at": row.created_at.isoformat(),
        "kind": row.kind,
        "label": label(row),
        "private": bool(row.private or row.thread_private),
        "thread_id": str(row.thread_id)
        if row.thread_id and not (row.private or row.thread_private)
        else None,
        "job_id": row.job_id,
        "provider": row.provider,
        "model": row.model,
        "rule": row.rule_id,
        "status": row.status,
        "latency_ms": row.latency_ms,
        "cost_usd": round(float(row.cost_usd or 0), 6),
        "value_usd": round(float(row.value_usd or 0), 6),
        "priced": int(row.priced or 0) > 0,
        "fallbacks": sum(1 for k in skips if isinstance(k, dict) and k.get("code") in ATTEMPTED),
    }


async def page(
    session: AsyncSession, r: Range, f: Filters, cursor: str | None = None, limit: int = PAGE
) -> dict[str, Any]:
    params: dict[str, Any] = {"s": r.start, "e": r.end, "lim": limit + 1}
    sql = _SQL + _where(f, params)
    key = decode_cursor(cursor)
    if key is not None:
        sql += " AND (r.created_at, r.id) < (:ct, :ci)"
        params["ct"], params["ci"] = key
    sql += " ORDER BY r.created_at DESC, r.id DESC LIMIT :lim"
    rows = (await session.execute(text(sql), params)).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "items": [as_dict(x) for x in rows],
        "next": encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else None,
    }


async def options(session: AsyncSession, r: Range) -> dict[str, list[str]]:
    """Values for the filter menus within the range (bounded)."""
    params: dict[str, Any] = {"s": r.start, "e": r.end}
    out: dict[str, list[str]] = {}
    for name, col in (("model", "d.model"), ("provider", "d.provider"), ("rule", "r.rule_id")):
        # `col` is one of three constants above; values are bound
        inner = _SQL.replace("SELECT r.id,", f"SELECT {col} AS v, r.id,", 1)
        sql = f"SELECT DISTINCT v FROM ({inner}) z WHERE v IS NOT NULL AND v <> '' ORDER BY v LIMIT 200"  # noqa: S608
        out[name] = [x.v for x in (await session.execute(text(sql), params)).all()]
    return out


# --- CSV (formula-injection safe, like the portal's lib/csv.ts) -------------------------------------------
RISKY = ("=", "+", "-", "@", "\t", "\r")
CSV_COLUMNS = (
    "at",
    "kind",
    "label",
    "provider",
    "model",
    "rule",
    "status",
    "latency_ms",
    "cost_usd",
    "value_usd",
    "fallbacks",
    "job_id",
)


def cell(v: Any) -> str:
    s = "" if v is None else str(v)
    if isinstance(v, int | float) and not isinstance(v, bool):
        return s  # numbers stay numbers (a negative number is not a formula)
    return "'" + s if s.startswith(RISKY) else s


async def csv_rows(session: AsyncSession, r: Range, f: Filters) -> AsyncIterator[str]:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    buf.write("﻿")
    w.writerow(CSV_COLUMNS)
    yield buf.getvalue()
    cursor, sent = None, 0
    while sent < CSV_MAX_ROWS:
        p = await page(session, r, f, cursor, limit=min(1000, CSV_MAX_ROWS - sent))
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        for item in p["items"]:
            w.writerow([cell(item[c]) for c in CSV_COLUMNS])
        sent += len(p["items"])
        yield buf.getvalue()
        cursor = p["next"]
        if not cursor:
            break
