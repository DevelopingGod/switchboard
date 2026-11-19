"""Catalog refresh: fetch live model lists, tag them, upsert into model_catalog (SPEC §6.4).

Rules:
- Providers without a key are skipped (connection status `no_key`); Ollama needs none.
- A model missing from a *successful* fetch is marked `missing`; a failed fetch changes no models.
- `deprecated` comes from provider metadata or the `deprecated:` list in model-tags.yaml.
"""

import asyncio
import logging
from datetime import UTC, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import secrets
from app.catalog.fetchers import FetchedModel, FetchError, fetch
from app.models import Connection, ModelCatalog
from app.registry import Provider, Registry, TagRules, load_registry, load_tag_rules

log = logging.getLogger("app.catalog")


def metadata_tags(m: FetchedModel) -> list[str]:
    tags: list[str] = []
    out, inp = set(m.output_modalities), set(m.input_modalities)
    mid = m.model_id.lower()
    if "embed" in mid:
        return ["embedding"]
    if "text" in out:
        tags.append("chat")
    if "image" in inp and "text" in out:
        tags.append("vision")
    for kind in ("image", "video", "audio"):
        if kind in out:
            tags.append(kind)
    if m.context and m.context >= 200_000:
        tags.append("long-context")
    if m.meta.get("reasoning"):
        tags.append("reasoning")
    return tags


def tag(provider: str, m: FetchedModel, rules: TagRules) -> tuple[list[str], str]:
    curated = rules.curated(provider, m.model_id)
    if curated is not None:
        # Curated tags win; long-context is still a fact from metadata.
        if m.context and m.context >= 200_000 and "long-context" not in curated:
            curated.append("long-context")
        return curated, "curated"
    derived = metadata_tags(m)
    return derived, "metadata" if derived else "untagged"


async def get_connection(session: AsyncSession, p: Provider) -> Connection:
    row = (await session.execute(select(Connection).where(Connection.provider == p.id))).scalar_one_or_none()
    if row is None:
        row = Connection(provider=p.id, kind=p.kind, status="no_key" if p.kind == "api_key" else "unknown")
        session.add(row)
        await session.flush()
    return row


async def upsert_models(
    session: AsyncSession, p: Provider, fetched: list[FetchedModel], rules: TagRules
) -> dict[str, int]:
    now = datetime.now(UTC)
    existing = {
        r.model_id: r
        for r in (await session.execute(select(ModelCatalog).where(ModelCatalog.provider == p.id))).scalars()
    }
    seen: set[str] = set()
    added = 0
    for m in fetched:
        if m.model_id in seen:
            continue
        seen.add(m.model_id)
        tags, source = tag(p.id, m, rules)
        status = "deprecated" if (m.deprecated or m.model_id in rules.deprecated) else "available"
        values = dict(
            display_name=m.display_name,
            tags_json=tags,
            tag_source=source,
            context=m.context,
            max_output=m.max_output,
            prices_json=m.prices,
            free=m.free,
            privacy=p.privacy,
            status=status,
            last_seen=now,
            meta_json={
                **m.meta,
                "input_modalities": m.input_modalities,
                "output_modalities": m.output_modalities,
            },
        )
        row = existing.get(m.model_id)
        if row is None:
            session.add(ModelCatalog(provider=p.id, model_id=m.model_id, first_seen=now, **values))
            added += 1
        else:
            for k, v in values.items():
                setattr(row, k, v)
    missing = 0
    for mid, row in existing.items():
        if mid not in seen and row.status != "missing":
            row.status = "missing"
            missing += 1
    return {"seen": len(seen), "added": added, "missing": missing}


async def refresh_provider(
    session: AsyncSession,
    client: httpx.AsyncClient,
    p: Provider,
    rules: TagRules,
    key: str | None = None,
) -> dict[str, object]:
    """Refresh one provider. `key` overrides the stored key (used to validate a new key)."""
    conn = await get_connection(session, p)
    if p.kind == "api_key" and key is None:
        key = await secrets.load_key(session, p.id)
        if key is None:
            conn.status, conn.last_error = "no_key", None
            await session.commit()
            return {"provider": p.id, "skipped": "no_key"}
    conn.last_checked = datetime.now(UTC)
    if p.params:
        p = p.with_params(await secrets.load_params(session, p.id))
    try:
        fetched = await fetch(client, p, key)
    except FetchError as e:
        conn.status, conn.last_error = "error", secrets.redact(str(e))
        await session.commit()
        log.warning("catalog %s: %s", p.id, conn.last_error)
        return {"provider": p.id, "error": conn.last_error}
    return await record_fetch(session, p, rules, fetched)


async def record_fetch(
    session: AsyncSession, p: Provider, rules: TagRules, fetched: list[FetchedModel]
) -> dict[str, object]:
    """Store a successful fetch and mark the connection connected."""
    conn = await get_connection(session, p)
    conn.last_checked = datetime.now(UTC)
    counts = await upsert_models(session, p, fetched, rules)
    conn.status, conn.last_error = "connected", None
    conn.meta_json = {**(conn.meta_json or {}), "catalog": {**counts, "at": conn.last_checked.isoformat()}}
    await session.commit()
    log.info("catalog %s: %s", p.id, counts)
    return {"provider": p.id, **counts}


async def refresh_all(
    session: AsyncSession, client: httpx.AsyncClient, registry: Registry | None = None
) -> list[dict[str, object]]:
    registry = registry or load_registry()
    rules = load_tag_rules()
    results = []
    for p in registry.providers.values():
        if p.kind == "cli" or not p.catalog:
            continue
        results.append(await refresh_provider(session, client, p, rules))
    return results


async def run_forever(sessionmaker, interval_s: int) -> None:  # pragma: no cover - timing loop
    """Startup refresh, then every `interval_s` seconds (24 h by default)."""
    while True:
        try:
            async with sessionmaker() as session, httpx.AsyncClient() as client:
                await refresh_all(session, client)
        except Exception:
            log.exception("catalog refresh failed")
        await asyncio.sleep(interval_s)
