"""Metrics API (M6, SPEC §8.6, ADR 0012). Read-only views over `metrics_15m` (+ the per-request list), each in
the viewer's time zone (`tz`, IANA) and range (`today`, `7d`, `30d`, or `custom` with `first`/`last`).
Demo traffic is left out unless `include_demo=true`. Answers are cached for 30 s per set of parameters."""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import require_admin
from app.metrics import insights, queries, subscriptions
from app.metrics.ranges import RangeError, resolve
from app.models import MetricsDirty
from app.registry import load_registry

# Spend, titles and job names: the same admin token as the chat API.
router = APIRouter(tags=["metrics"], dependencies=[Depends(require_admin)])

TTL_S = 30.0
CACHE_MAX = 256


class _Cache:
    """Small bounded LRU with a TTL (one process; the numbers are at most 30 s old)."""

    def __init__(self) -> None:
        self._d: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()

    async def get(self, key: tuple, make: Callable[[], Awaitable[Any]]) -> Any:
        now = time.monotonic()
        hit = self._d.get(key)
        if hit and now - hit[0] < TTL_S:
            self._d.move_to_end(key)
            return hit[1]
        val = await make()
        self._d[key] = (now, val)
        self._d.move_to_end(key)
        while len(self._d) > CACHE_MAX:
            self._d.popitem(last=False)
        return val

    def clear(self) -> None:
        self._d.clear()


cache = _Cache()


def _range(range_: str, tz: str | None, first: str | None, last: str | None):
    try:
        return resolve(range_, tz, first=first, last=last)
    except RangeError as e:
        raise HTTPException(400, str(e)) from e


Common = dict[str, Any]


def common(
    range_: str = Query("7d", alias="range"),
    tz: str = Query("UTC", max_length=64),
    first: str | None = Query(None, max_length=10),
    last: str | None = Query(None, max_length=10),
    include_demo: bool = False,
) -> Common:
    return {"r": _range(range_, tz, first, last), "demo": include_demo}


def _ckey(name: str, c: Common, *extra: Any) -> tuple:
    r = c["r"]
    return (name, r.key, r.tz.key, r.first, r.last, r.slot, c["demo"], *extra)


async def _pending(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count()).select_from(MetricsDirty)) or 0)


@router.get("/metrics/summary")
async def summary(
    c: Common = Depends(common), session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    async def make() -> dict[str, Any]:
        r, demo = c["r"], c["demo"]
        t = await queries.totals(session, r, demo)
        fees, subs = await queries.fees_for(session, r)
        registry = load_registry()
        names = {pid: p.name.split(" (")[0] for pid, p in registry.providers.items()}
        free_rows = await queries.free_share(session, r, demo)
        by_agent = (await queries.breakdown(session, r, demo, "agent", limit=10))["items"]
        budgets = await queries.budgets(session) if r.key == "today" else None
        net = t["value_usd"] - fees - t["spent_usd"]
        return {
            "range": r.as_dict(),
            "totals": {
                **t,
                "subscriptions_usd": round(fees, 6),
                "net_saved_usd": round(net, 6),
                "has_subscriptions": bool(subs),
            },
            "series": await queries.series(session, r, demo),
            "insights": insights.build(
                totals=t,
                fees=fees,
                has_subs=bool(subs),
                free_rows=free_rows,
                names=names,
                chat_budget=budgets["chat"] if budgets else None,
                job_rows=by_agent,
                tz=r.tz,
            ),
            "include_demo": demo,
            "pending_buckets": await _pending(session),
        }

    return await cache.get(_ckey("summary", c), make)


@router.get("/metrics/breakdown")
async def breakdown(
    by: str = Query(..., pattern="^(provider|model|agent|rule|intent|project|kind)$"),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(25, ge=1, le=100),
    c: Common = Depends(common),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await cache.get(
        _ckey("breakdown", c, by, cursor, limit),
        lambda: queries.breakdown(session, c["r"], c["demo"], by, cursor, limit),
    )


@router.get("/metrics/series")
async def series(c: Common = Depends(common), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    async def make() -> dict[str, Any]:
        return {"range": c["r"].as_dict(), "series": await queries.series(session, c["r"], c["demo"])}

    return await cache.get(_ckey("series", c), make)


@router.get("/metrics/quotas")
async def quotas(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await cache.get(("quotas",), lambda: _wrap("providers", queries.quotas(session)))


@router.get("/metrics/budgets")
async def budgets(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await cache.get(("budgets",), lambda: queries.budgets(session))


@router.get("/metrics/top-requests")
async def top_requests(
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(20, ge=1, le=100),
    c: Common = Depends(common),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    return await cache.get(
        _ckey("top", c, cursor, limit),
        lambda: queries.top_requests(session, c["r"], c["demo"], cursor, limit),
    )


async def _wrap(key: str, aw: Awaitable[Any]) -> dict[str, Any]:
    return {key: await aw}


# --- Settings → Subscriptions ---------------------------------------------------------------------
@router.get("/settings/subscriptions")
async def get_subscriptions(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return {"items": [s.model_dump(mode="json") for s in await subscriptions.load(session)]}


@router.put("/settings/subscriptions")
async def put_subscriptions(
    body: subscriptions.Subscriptions, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    items = await subscriptions.save(session, body.items)
    cache.clear()  # net savings change at once
    return {"items": [s.model_dump(mode="json") for s in items]}
