"""Builds the engine Context from the DB: connected providers, catalog, preset, today's spend."""

import json
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import credits
from app.models import Connection, Cost, ModelCatalog, ModelStats, ProviderSecret, SystemMeta
from app.registry import Registry, load_registry
from app.routing.engine import CatalogEntry, Context
from app.routing.health import cooldowns
from app.routing.rules import load_rules


async def active_preset(session: AsyncSession) -> str | None:
    row = await session.get(SystemMeta, "onboarding")
    if not row:
        return None
    try:
        return json.loads(row.value).get("preset")
    except ValueError:
        return None


async def connected_providers(session: AsyncSession, registry: Registry) -> set[str]:
    """API-key providers with a stored key, plus local providers unless their last check failed."""
    keyed = set((await session.execute(select(ProviderSecret.provider))).scalars())
    status = {c.provider: c.status for c in (await session.execute(select(Connection))).scalars()}
    out: set[str] = set()
    for p in registry.providers.values():
        if p.kind == "api_key" and p.id in keyed:
            out.add(p.id)
        elif p.kind == "local" and status.get(p.id) != "error":
            out.add(p.id)
    return out


async def load_catalog(session: AsyncSession) -> list[CatalogEntry]:
    q = (
        select(ModelCatalog, ModelStats.p50_ms)
        .outerjoin(ModelStats, (ModelStats.model_id == ModelCatalog.id) & (ModelStats.task_type == "test"))
        .where(ModelCatalog.status == "available")
    )
    out: list[CatalogEntry] = []
    for m, p50 in (await session.execute(q)).all():
        prices = m.prices_json or {}
        out.append(
            CatalogEntry(
                id=m.id,
                provider=m.provider,
                model_id=m.model_id,
                display_name=m.display_name,
                tags=tuple(m.tags_json or ()),
                context=m.context,
                input_per_1m=prices.get("input_per_1m"),
                output_per_1m=prices.get("output_per_1m"),
                privacy=m.privacy,
                p50_ms=p50,
            )
        )
    return out


def day_start() -> datetime:
    now = datetime.now(UTC)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


async def spent_today(session: AsyncSession) -> float:
    """What counts toward the daily cap: `cost_usd` only (free-tier calls are $0 there)."""
    total = await session.scalar(
        select(func.coalesce(func.sum(Cost.cost_usd), 0)).where(Cost.created_at >= day_start())
    )
    return float(total or 0)


async def build_context(session: AsyncSession) -> Context:
    registry = load_registry()
    rules = load_rules().with_preset(await active_preset(session))
    used_up = await credits.exhausted(session, registry)
    return Context(
        registry=registry,
        rules=rules,
        connected=await connected_providers(session, registry) - used_up.keys(),
        exhausted=used_up,
        catalog=await load_catalog(session),
        cooldowns=cooldowns,
        spent_today=await spent_today(session),
    )
