"""Bring LiteLLM calls the router didn't record into `costs` (M6, ADR 0012).

The router already writes a cost row for each chat turn, keyed `litellm:<call id>`. This job reads LiteLLM's
spend logs since a persisted cursor (with a 10-minute overlap, because LiteLLM writes its logs in batches) and
inserts each successful call with the same key and `ON CONFLICT DO NOTHING`, so a call is counted exactly once
whichever side wrote it first. What it adds:
- `aux`: the router's own titles and summaries through a cloud model;
- `test`: model tests run through LiteLLM;
- `external`: any other LiteLLM client (a script, an IDE plugin, Hermes);
- `chat`: only if the router crashed before writing a turn's row.
Failed calls are skipped (they cost nothing; the router logs its own failures in `requests`). Demo traffic
keeps its tag (`end_user` / `request_tags` = ROUTER_REQUEST_TAG value) so the dashboard can leave it out.

Only the main router runs this (ROUTER_SYNC_ENABLED): the demo router shares LiteLLM, not the database.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import db, litellm_calls
from app.litellm_spend import LiteLLMSpend, SpendLog, SpendLogError
from app.models import Cost, SystemMeta
from app.registry import Registry, load_registry

log = logging.getLogger("app.metrics.ingest")

CURSOR_KEY = "metrics.litellm_cursor"
START_KEY = "metrics.litellm_start"  # when ingest first ran: unmarked calls before it are pre-M6 chat turns
OVERLAP = timedelta(minutes=10)
# LiteLLM's logs from before ingest first ran (START_KEY) can't be told apart from the router's own chat turns
# (those had no `sb-` call id and are already in `costs`), so only `sb-` calls are taken from before then.
FIRST_LOOKBACK = timedelta(minutes=30)
INTERVAL_S = 300
# A chat turn's own row is written by the router when the stream ends. Chat logs younger than this are left
# for a later run, so the router always writes first (its insert has no ON CONFLICT); the cursor never moves
# past them.
SETTLE = timedelta(minutes=15)
DEMO_TAGS = ("switchboard-demo",)


def _tag(lg: SpendLog) -> str | None:
    for t in (lg.end_user, *lg.tags):
        if t in DEMO_TAGS:
            return t
    return None


def _provider(registry: Registry, lg: SpendLog) -> tuple[str, str]:
    """(provider id, model id) in the registry's terms when it can tell, else LiteLLM's own names."""
    p = registry.provider_for_litellm_model(lg.model) if lg.model else None
    if p is None:
        return (lg.provider or "unknown")[:64], lg.model
    prefix = f"{p.litellm_prefix}/"
    return p.id, lg.model[len(prefix) :] if lg.model.startswith(prefix) else lg.model


def row_for(registry: Registry, lg: SpendLog) -> dict | None:
    if lg.status != "success":
        return None
    kind = litellm_calls.kind_of(lg.call_id)
    provider, model_id = _provider(registry, lg)
    p = registry.providers.get(provider)
    free = bool(p and (p.kind == "local" or p.is_free_tier(model_id)))
    spend = lg.spend
    return {
        "request_id": None,
        "source": "litellm",
        "kind": kind,
        "provider": provider,
        "model": lg.model[:255] or lg.model_group[:255] or None,
        "tokens_in": lg.tokens_in,
        "tokens_out": lg.tokens_out,
        "cost_usd": 0.0 if free or spend is None else spend,
        "list_price_usd": spend,
        "external_id": litellm_calls.external_id(lg.call_id),
        "tag": _tag(lg),
        "created_at": lg.started,
    }


async def _cursor(session: AsyncSession, key: str = CURSOR_KEY) -> datetime | None:
    v = await session.scalar(select(SystemMeta.value).where(SystemMeta.key == key))
    try:
        return datetime.fromisoformat(v) if v else None
    except ValueError:
        return None


async def _save_cursor(session: AsyncSession, at: datetime, key: str = CURSOR_KEY) -> None:
    stmt = insert(SystemMeta).values(key=key, value=at.isoformat())
    await session.execute(
        stmt.on_conflict_do_update(index_elements=["key"], set_={"value": stmt.excluded.value})
    )


async def run_once(
    session: AsyncSession, spend: LiteLLMSpend, registry: Registry | None = None, now: datetime | None = None
) -> int:
    """Ingest new spend logs; returns how many rows were inserted."""
    registry = registry or load_registry()
    now = now or datetime.now(UTC)
    cur = await _cursor(session)
    since = (cur - OVERLAP) if cur else now - FIRST_LOOKBACK
    start = await _cursor(session, START_KEY)
    if start is None:
        start = now
        await _save_cursor(session, start, START_KEY)
    newest = cur
    inserted = 0
    settled = now - SETTLE
    async for lg in spend.logs(since, now + timedelta(minutes=1)):
        newest = lg.started if newest is None or lg.started > newest else newest
        row = row_for(registry, lg)
        if row is None or (row["kind"] == "chat" and lg.started > settled):
            continue
        if row["kind"] == "external" and lg.started < start:
            continue  # from before the first run: see FIRST_LOOKBACK
        new_id = await session.scalar(
            insert(Cost)
            .values(**row)
            .on_conflict_do_nothing(index_elements=["external_id"])
            .returning(Cost.id)
        )
        inserted += new_id is not None
    await _save_cursor(session, min(newest or now, settled))
    await session.commit()
    return inserted


async def run_forever(stop: asyncio.Event | None = None) -> None:
    spend = LiteLLMSpend()
    try:
        while not (stop and stop.is_set()):
            try:
                async with db.sessionmaker()() as session:
                    n = await run_once(session, spend)
                if n:
                    log.info("metrics: %d LiteLLM call(s) added from spend logs", n)
            except SpendLogError as e:
                log.info("metrics: %s; will retry", e)
            except Exception:  # noqa: BLE001 - keep the loop alive; the cursor only moves on success
                log.exception("metrics: LiteLLM ingest failed")
            await asyncio.sleep(INTERVAL_S)
    finally:
        await spend.aclose()
