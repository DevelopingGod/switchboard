"""One-time and startup tasks: connection rows, key fingerprints, .env key import."""

import logging
import os

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import secrets
from app.catalog.job import get_connection
from app.config import get_settings
from app.models import ProviderSecret, SystemMeta
from app.registry import Registry

log = logging.getLogger("app.startup")

FINGERPRINTED = ("switchboard_secret_key", "litellm_salt_key")


async def ensure_connections(session: AsyncSession, registry: Registry) -> None:
    for p in registry.providers.values():
        await get_connection(session, p)
    await session.commit()


async def _meta(session: AsyncSession, key: str) -> SystemMeta | None:
    return await session.get(SystemMeta, key)


async def record_fingerprints(session: AsyncSession) -> None:
    """Store SHA-256 of each secret key on first start; later starts never overwrite it."""
    s = get_settings()
    for name in FINGERPRINTED:
        value = getattr(s, name)
        if value is None:
            continue
        if await _meta(session, f"fingerprint:{name}") is None:
            session.add(
                SystemMeta(key=f"fingerprint:{name}", value=secrets.fingerprint(value.get_secret_value()))
            )
    await session.commit()


async def key_checks(session: AsyncSession) -> dict[str, str]:
    """ok | changed | unset | unrecorded for each fingerprinted key (read by doctor.sh)."""
    s = get_settings()
    out = {}
    for name in FINGERPRINTED:
        value = getattr(s, name)
        row = await _meta(session, f"fingerprint:{name}")
        if value is None or not value.get_secret_value():
            out[name] = "unset"
        elif row is None:
            out[name] = "unrecorded"
        else:
            out[name] = "ok" if row.value == secrets.fingerprint(value.get_secret_value()) else "changed"
    return out


async def import_env_keys(session: AsyncSession, registry: Registry) -> list[str]:
    """Import provider keys from deploy/.env once per provider. A key later removed through the API
    is not re-imported (the marker stays)."""
    imported = []
    for p in registry.api_providers():
        value = os.environ.get(p.env_key or "", "").strip()
        marker = f"env_imported:{p.id}"
        if not value or await _meta(session, marker) is not None:
            continue
        if await session.get(ProviderSecret, p.id) is None:
            await secrets.store_key(session, p.id, value, source="env-import")
            imported.append(p.id)
        session.add(SystemMeta(key=marker, value="1"))
    await session.commit()
    if imported:
        log.info("imported provider keys from deploy/.env: %s", ", ".join(imported))
    return imported


async def env_keys_still_present(session: AsyncSession, registry: Registry) -> list[str]:
    """Env var names that were imported but are still set in deploy/.env (optional to remove)."""
    out = []
    markers = {
        m.key.split(":", 1)[1]
        for m in (
            await session.execute(select(SystemMeta).where(SystemMeta.key.like("env_imported:%")))
        ).scalars()
    }
    for p in registry.api_providers():
        if p.id in markers and p.env_key and os.environ.get(p.env_key, "").strip():
            out.append(p.env_key)
    return out
