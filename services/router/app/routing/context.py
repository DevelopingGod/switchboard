"""Builds the engine Context from the DB: connected providers, catalog, preset, today's spend."""

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import credits, quota, rules_versions, user_settings
from app.models import Connection, Cost, ModelCatalog, ModelStats, ProviderSecret, SystemMeta
from app.registry import Registry, load_registry
from app.routing.engine import CatalogEntry, Context
from app.routing.health import cooldowns
from app.routing.recommend import Stat


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
    q = select(ModelCatalog).where(ModelCatalog.status == "available")
    stats: dict[int, dict[str, Stat]] = {}
    for st in (await session.execute(select(ModelStats))).scalars():
        stats.setdefault(st.model_id, {})[st.task_type] = Stat(
            samples=st.samples,
            failures=st.failures,
            p50_ms=st.p50_ms,
            up=st.thumbs_up or 0,
            down=st.thumbs_down or 0,
        )
    out: list[CatalogEntry] = []
    for m in (await session.execute(q)).scalars():
        prices = m.prices_json or {}
        own = stats.get(m.id) or {}
        p50 = own["test"].p50_ms if "test" in own else None
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
                stats=own,
            )
        )
    return out


def day_start() -> datetime:
    now = datetime.now(UTC)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


async def value_saved_today(session: AsyncSession) -> float:
    """What today's free-tier calls would have cost at list price (shown as "value saved")."""
    total = await session.scalar(
        select(func.coalesce(func.sum(Cost.list_price_usd), 0)).where(
            Cost.created_at >= day_start(), Cost.cost_usd == 0, Cost.list_price_usd.is_not(None)
        )
    )
    return float(total or 0)


async def spent_today(session: AsyncSession) -> float:
    """What counts toward the daily cap: `cost_usd` only (free-tier calls are $0 there)."""
    total = await session.scalar(
        select(func.coalesce(func.sum(Cost.cost_usd), 0)).where(Cost.created_at >= day_start())
    )
    return float(total or 0)


async def build_context(session: AsyncSession, draft: dict[str, Any] | None = None) -> Context:
    """`draft`: an unsaved Rules UI override document (the dry-run tester); raises RulesInvalid."""
    registry = load_registry()
    rules = (
        (await rules_versions.effective_rules(session, draft))
        .with_preset(await active_preset(session))
        .with_settings(await user_settings.load(session))
    )
    used_up = await credits.exhausted(session, registry)
    owner = await user_settings.load(session)
    return Context(
        registry=registry,
        rules=rules,
        connected=await connected_providers(session, registry) - used_up.keys(),
        exhausted=used_up,
        catalog=await load_catalog(session),
        cooldowns=cooldowns,
        spent_today=await spent_today(session),
        quota=await quota.load_view(session, registry),
        explore=bool(owner.get("explore", False)),
        auto_private=bool(owner.get("auto_private", True)),
    )
