"""Read side of Metrics (M6): everything reads `metrics_15m` by `bucket_start` range (indexed), except the
per-request list, which reads `costs` by `created_at` (indexed) and pages by keyset.

Money words (ADR 0012):
- spent_usd: real money (`cost_usd`), what counts toward caps;
- value_usd: "value at API prices", what all of it would have cost at the providers' list prices
  (`list_price_usd`; when a source reports no list price, what was paid);
- net_saved_usd = value − subscription fees for the range − spent.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import jobs, quota, rules_versions, secrets, user_settings
from app.agents import load_agents
from app.metrics import hist, subscriptions
from app.metrics.ranges import Range
from app.registry import Registry, load_registry
from app.routing.context import connected_providers, day_start, spent_today

DIMS = {
    "provider": "provider",
    "model": "model",
    "agent": "agent",
    "rule": "rule_id",
    "intent": "intent",
    "project": "project_id",
    "kind": "kind",
}
KIND_LABELS = {
    "chat": "Chat",
    "media": "Media",
    "job": "Agent jobs",
    "aux": "Titles and summaries",
    "test": "Model tests",
    "external": "Other LiteLLM clients",
}
MEASURES = """
    COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(errors), 0) AS errors,
    COALESCE(SUM(rate_limited), 0) AS rate_limited, COALESCE(SUM(timeouts), 0) AS timeouts,
    COALESCE(SUM(fallbacks), 0) AS fallbacks, COALESCE(SUM(tokens_in), 0) AS tokens_in,
    COALESCE(SUM(tokens_out), 0) AS tokens_out, COALESCE(SUM(cost_usd), 0) AS spent_usd,
    COALESCE(SUM(list_price_usd), 0) AS value_usd, COALESCE(SUM(unpriced), 0) AS unpriced,
    COALESCE(SUM(jobs_done), 0) AS jobs_done, COALESCE(SUM(jobs_failed), 0) AS jobs_failed,
    COALESCE(SUM(thumbs_up), 0) AS thumbs_up, COALESCE(SUM(thumbs_down), 0) AS thumbs_down
"""
WHERE = "bucket_start >= :s AND bucket_start < :e AND (:demo OR NOT demo)"
WHERE_M = "m.bucket_start >= :s AND m.bucket_start < :e AND (:demo OR NOT m.demo)"
MONEY = ("spent_usd", "value_usd")


def _p(r: Range, include_demo: bool, **extra: Any) -> dict[str, Any]:
    return {"s": r.start, "e": r.end, "demo": include_demo, "tz": r.tz.key, **extra}


def _row(m: Any) -> dict[str, Any]:
    d = dict(m._mapping)
    for k, v in d.items():
        if k in MONEY:
            d[k] = round(float(v or 0), 6)
        elif isinstance(v, int | float) or v is None:
            continue
        elif hasattr(v, "__int__") and k not in ("key", "slot"):
            d[k] = int(v)
    return d


# --- totals and series ---------------------------------------------------------------------------
async def totals(session: AsyncSession, r: Range, include_demo: bool) -> dict[str, Any]:
    row = (
        await session.execute(
            text(
                f"""SELECT {MEASURES},
                  COALESCE(SUM(requests) FILTER (WHERE kind IN ('chat', 'media')), 0) AS chats,
                  COALESCE(SUM(requests) FILTER (WHERE demo), 0) AS demo_requests
                FROM metrics_15m WHERE bucket_start >= :s AND bucket_start < :e"""
                + ("" if include_demo else " AND NOT demo")
            ),
            _p(r, include_demo),
        )
    ).one()
    out = _row(row)
    # Demo rows left out: say how many, so an empty dashboard after a demo isn't a mystery.
    if not include_demo:
        out["demo_requests"] = int(
            await session.scalar(
                text(
                    "SELECT COALESCE(SUM(requests), 0) FROM metrics_15m "
                    "WHERE bucket_start >= :s AND bucket_start < :e AND demo"
                ),
                _p(r, include_demo),
            )
            or 0
        )
    return out


async def series(session: AsyncSession, r: Range, include_demo: bool) -> list[dict[str, Any]]:
    """One point per local hour (today) or local day, with empty slots filled, plus p50/p95 latency."""
    unit = r.slot
    rows = (
        await session.execute(
            text(
                f"""SELECT date_trunc('{unit}', bucket_start AT TIME ZONE :tz) AS slot, {MEASURES}
                FROM metrics_15m WHERE {WHERE} GROUP BY 1 ORDER BY 1"""
            ),
            _p(r, include_demo),
        )
    ).all()
    hists = await _hists(session, r, include_demo, f"date_trunc('{unit}', bucket_start AT TIME ZONE :tz)")
    by = {row.slot: _row(row) for row in rows}
    step = timedelta(hours=1) if unit == "hour" else timedelta(days=1)
    t = r.start.astimezone(r.tz).replace(tzinfo=None)
    end = r.end.astimezone(r.tz).replace(tzinfo=None)
    if unit == "day":
        end = datetime.combine(r.last, datetime.min.time()) + step
    out = []
    while t < end:
        d = by.get(t) or {k: 0 for k in _zero()}
        d.pop("slot", None)
        h = hists.get(t, (hist.empty(), hist.empty()))
        d.update(
            slot=t.isoformat(),
            p50_ms=hist.percentile(h[0], 0.5),
            p95_ms=hist.percentile(h[0], 0.95),
            ttft_p50_ms=hist.percentile(h[1], 0.5),
        )
        out.append(d)
        t += step
    return out


def _zero() -> dict[str, int]:
    return {
        k: 0
        for k in (
            "requests ok errors rate_limited timeouts fallbacks tokens_in tokens_out spent_usd value_usd "
            "unpriced jobs_done jobs_failed thumbs_up thumbs_down"
        ).split()
    }


async def _hists(
    session: AsyncSession, r: Range, include_demo: bool, group: str
) -> dict[Any, tuple[list[int], list[int]]]:
    """Element-wise sums of the latency histograms per group, in SQL (one row per group and slot)."""
    rows = (
        await session.execute(
            text(
                f"""SELECT {group} AS g, u.i AS i, SUM(u.v) AS lat, SUM(COALESCE(m.ttft_hist[u.i], 0)) AS ttft
                FROM metrics_15m m, unnest(m.lat_hist) WITH ORDINALITY u(v, i)
                WHERE {WHERE_M}
                GROUP BY 1, 2"""
            ),
            _p(r, include_demo),
        )
    ).all()
    out: dict[Any, tuple[list[int], list[int]]] = {}
    for g, i, lat, ttft in rows:
        a, b = out.setdefault(g, (hist.empty(), hist.empty()))
        if 1 <= i <= hist.SIZE:
            a[i - 1] += int(lat or 0)
            b[i - 1] += int(ttft or 0)
    return out


# --- breakdowns -----------------------------------------------------------------------------------
def _cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode()


def _offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        return max(0, int(json.loads(base64.urlsafe_b64decode(cursor.encode()))["o"]))
    except (ValueError, KeyError, TypeError):
        return 0


async def labels(session: AsyncSession, by: str, keys: list[Any], registry: Registry) -> dict[Any, str]:
    if by == "provider":
        return {
            k: (registry.providers[k].name.split(" (")[0] if k in registry.providers else k) for k in keys
        }
    if by == "agent":
        reg = load_agents()
        return {k: (reg.agents[k].label if k in reg.agents else k) for k in keys}
    if by == "project":
        ids = [int(k) for k in keys if k]
        names = {}
        if ids:
            names = dict(
                (
                    await session.execute(
                        text("SELECT id, name FROM projects WHERE id = ANY(:ids)"), {"ids": ids}
                    )
                ).all()
            )
        return {k: names.get(int(k), f"Project {k}") for k in keys if k}
    if by == "kind":
        return {k: KIND_LABELS.get(k, k) for k in keys}
    return {k: str(k) for k in keys}


async def breakdown(
    session: AsyncSession,
    r: Range,
    include_demo: bool,
    by: str,
    cursor: str | None = None,
    limit: int = 25,
    kinds: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    col = DIMS[by]
    empty = "0" if col == "project_id" else "''"
    kind_filter = " AND kind = ANY(:kinds)" if kinds else ""
    offset = _offset(cursor)
    params = _p(r, include_demo, lim=limit + 1, off=offset, kinds=list(kinds or ()))
    rows = (
        await session.execute(
            text(
                f"""SELECT {col} AS key, {MEASURES} FROM metrics_15m
                WHERE {WHERE} AND {col} <> {empty}{kind_filter}
                GROUP BY {col} ORDER BY value_usd DESC, requests DESC, jobs_done DESC, key
                LIMIT :lim OFFSET :off"""
            ),
            params,
        )
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    keys = [row.key for row in rows]
    hists: dict[Any, tuple[list[int], list[int]]] = {}
    if keys:
        hists = await _hists(session, r, include_demo, col)
    names = await labels(session, by, keys, load_registry())
    items = []
    for row in rows:
        d = _row(row)
        h = hists.get(row.key, (hist.empty(), hist.empty()))
        votes = d["thumbs_up"] + d["thumbs_down"]
        runs = d["jobs_done"] + d["jobs_failed"]
        d.update(
            key=str(row.key),
            label=names.get(row.key, str(row.key)),
            p50_ms=hist.percentile(h[0], 0.5),
            p95_ms=hist.percentile(h[0], 0.95),
            error_rate=(d["errors"] / d["requests"]) if d["requests"] else None,
            thumbs_up_rate=(d["thumbs_up"] / votes) if votes else None,
            job_success_rate=(d["jobs_done"] / runs) if runs else None,
        )
        items.append(d)
    return {"by": by, "items": items, "next": _cursor(offset + limit) if more else None}


async def free_share(session: AsyncSession, r: Range, include_demo: bool) -> list[dict[str, Any]]:
    """Chats per provider and how many of them cost nothing (for the "handled X% for free" insight)."""
    rows = (
        await session.execute(
            text(
                f"""SELECT provider, SUM(requests) AS n,
                  SUM(requests) FILTER (WHERE cost_usd = 0) AS free
                FROM metrics_15m WHERE {WHERE} AND kind IN ('chat', 'media') AND provider <> ''
                GROUP BY provider ORDER BY n DESC"""
            ),
            _p(r, include_demo),
        )
    ).all()
    return [{"provider": p, "requests": int(n or 0), "free": int(f or 0)} for p, n, f in rows]


# --- quotas and budgets ---------------------------------------------------------------------------
async def quotas(session: AsyncSession, now: datetime | None = None) -> list[dict[str, Any]]:
    """Per connected provider with known limits: every window of its busiest model (today vs limit, when it
    resets). Reads the quota guard's own counters and headers (app.quota), so it matches routing."""
    registry = load_registry()
    view = await quota.load_view(session, registry, now)
    out = []
    for pid in sorted(await connected_providers(session, registry)):
        p = registry.providers.get(pid)
        pol = quota.policy(p) if p else None
        if p is None or pol is None:
            continue
        keys = {k[1] for k in view.counters if k[0] == pid} | {k[1] for k in view.headers if k[0] == pid}
        best: tuple[str, list[quota.Usage]] | None = None
        for key in keys or {"*"}:
            ws = view.windows_for(pid, pol, key, quota.limit_of(pol, key))
            top = max((w.fraction for w in ws), default=0)
            if ws and (best is None or top > max(w.fraction for w in best[1])):
                best = (key, ws)
        if not best:
            continue
        out.append(
            {
                "provider": pid,
                "name": p.name.split(" (")[0],
                "model": None if best[0] == "*" else best[0],
                "windows": [w.as_dict() for w in sorted(best[1], key=lambda w: -w.fraction)],
                "limits_note": p.free_limits,
            }
        )
    return sorted(out, key=lambda q: -max((w["fraction"] for w in q["windows"]), default=0))


def forecast(
    spent: float, cap: float | None, since: datetime, resets: datetime, now: datetime
) -> dict[str, Any]:
    """Straight-line forecast from today's average rate: when the cap is reached, if before the reset."""
    out: dict[str, Any] = {"spent": round(spent, 6), "cap": cap, "resets_at": resets.isoformat()}
    if cap is None or cap <= 0:
        out.update(fraction=None, state="no_cap", hits_at=None)
        return out
    out["fraction"] = spent / cap
    if spent >= cap:
        out.update(state="reached", hits_at=None)
        return out
    hours = max((now - since).total_seconds() / 3600, 0.25)  # a quarter hour at least: no wild early swings
    rate = spent / hours
    if rate <= 0:
        out.update(state="idle", hits_at=None)
        return out
    hits = now + timedelta(hours=(cap - spent) / rate)
    out.update(
        state="on_track" if hits >= resets else "will_reach",
        hits_at=hits.isoformat() if hits < resets else None,
    )
    return out


async def budgets(session: AsyncSession, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    o = await user_settings.load(session)
    rules = await rules_versions.effective_rules(session)
    cap = float(o.get("daily_cap_usd", rules.defaults.daily_cap_usd))
    d0 = day_start()  # the caps' day (UTC), not the viewer's: that is when they reset
    chat = forecast(await spent_today(session), cap, d0, d0 + timedelta(days=1), now)
    reg = load_agents()
    agents_out = []
    m0 = jobs.month_start()
    for a in reg.agents.values():
        if not a.runnable:
            continue
        today = await jobs.agent_spent_since(session, a.id, d0)
        month = await jobs.agent_spent_since(session, a.id, m0)
        monthly = (
            a.monthly_list_usd if a.monthly_list_usd is not None else reg.defaults.per_agent_monthly_list_usd
        )
        next_month = (m0.replace(day=28) + timedelta(days=4)).replace(day=1)
        agents_out.append(
            {
                "agent": a.id,
                "label": a.label,
                "today": forecast(
                    today, reg.defaults.per_agent_daily_list_usd, d0, d0 + timedelta(days=1), now
                ),
                "month": forecast(month, monthly, m0, next_month, now),
            }
        )
    return {
        "chat": chat,
        "agents": agents_out,
        "note": "Agent budgets count list price; the chat cap counts real money.",
    }


# --- per-request list (privacy: titles and job names only, never content) -------------------------
PRIVATE_LABEL = "Private chat"
KIND_ROW_LABELS = {"aux": "Title or summary", "test": "Model test", "external": "Another LiteLLM client"}


def safe_title(title: str | None, private: bool) -> str:
    if private:
        return PRIVATE_LABEL
    t = secrets.redact(" ".join((title or "").split()))[:120]
    return t or "Untitled chat"


def _key(cursor: str | None) -> tuple[float, int] | None:
    if not cursor:
        return None
    try:
        d = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return float(d["v"]), int(d["id"])
    except (ValueError, KeyError, TypeError):
        return None


async def top_requests(
    session: AsyncSession, r: Range, include_demo: bool, cursor: str | None = None, limit: int = 20
) -> dict[str, Any]:
    """Most valuable events first (list price), keyset paged by (value, id). Only labels leave here: a
    thread's title (or "Private chat"), a job's name, or what kind of call it was."""
    k = _key(cursor)
    rows = (
        await session.execute(
            text(
                f"""SELECT c.id, c.created_at, c.kind, c.provider, c.model, c.cost_usd,
                  COALESCE(c.list_price_usd, c.cost_usd, 0) AS value, c.tokens_in, c.tokens_out,
                  c.request_id, r.rule_id, r.intent, t.title,
                  COALESCE(t.private, r.private, false) AS private,
                  j.id AS job_id, j.title AS job_title, j.agent
                FROM costs c
                LEFT JOIN requests r ON r.id = c.request_id
                LEFT JOIN threads t ON t.id = r.thread_id
                LEFT JOIN jobs j ON j.id = c.job_id
                WHERE c.created_at >= :s AND c.created_at < :e
                  AND (:demo OR COALESCE(c.tag, '') = '')
                  {"AND (COALESCE(c.list_price_usd, c.cost_usd, 0), c.id) < (:kv, :kid)" if k else ""}
                ORDER BY value DESC, c.id DESC LIMIT :lim"""
            ),
            _p(r, include_demo, lim=limit + 1, kv=k[0] if k else 0, kid=k[1] if k else 0),
        )
    ).all()
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    for x in rows:
        kind = x.kind or "chat"
        if x.job_id is not None:
            label = secrets.redact(" ".join((x.job_title or "").split()))[:120] or f"Job {x.job_id}"
        elif kind in ("chat", "media") and x.request_id is not None:
            label = safe_title(x.title, bool(x.private))
        else:
            label = KIND_ROW_LABELS.get(kind, "Chat")
        items.append(
            {
                "id": x.id,
                "at": x.created_at.isoformat(),
                "kind": kind,
                "label": label,
                "private": bool(x.private),
                "provider": x.provider,
                "model": x.model,
                "spent_usd": round(float(x.cost_usd or 0), 6),
                "value_usd": round(float(x.value or 0), 6),
                "tokens": int(x.tokens_in or 0) + int(x.tokens_out or 0),
                "request_id": x.request_id,
                "job_id": x.job_id,
                "agent": x.agent,
                "rule_id": x.rule_id,
                "intent": x.intent,
            }
        )
    nxt = None
    if more and items:
        last = items[-1]
        nxt = base64.urlsafe_b64encode(
            json.dumps({"v": last["value_usd"], "id": last["id"]}).encode()
        ).decode()
    return {"items": items, "next": nxt}


async def fees_for(session: AsyncSession, r: Range) -> tuple[float, list[dict[str, Any]]]:
    items = await subscriptions.load(session)
    return subscriptions.fees(items, r.first, r.last), [s.model_dump(mode="json") for s in items]
