"""Migrations, one-time .env import, and secret-key fingerprints."""

import os

import pytest
from alembic import command
from sqlalchemy import select

from app import startup
from app.config import get_settings
from app.models import ProviderSecret, SystemMeta
from app.registry import load_registry
from tests.conftest import alembic_cfg


def test_migration_round_trip():
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


async def test_env_import_once(session, monkeypatch):
    reg = load_registry()
    monkeypatch.setenv("GROQ_API_KEY", "gsk_fromENVfile0123456789")
    assert await startup.import_env_keys(session, reg) == ["groq"]
    row = await session.get(ProviderSecret, "groq")
    assert row.source == "env-import"
    assert await startup.env_keys_still_present(session, reg) == ["GROQ_API_KEY"]

    # Removed through the API -> not re-imported on the next start.
    await session.delete(row)
    await session.commit()
    assert await startup.import_env_keys(session, reg) == []
    assert await session.get(ProviderSecret, "groq") is None

    monkeypatch.delenv("GROQ_API_KEY")
    assert await startup.env_keys_still_present(session, reg) == []


async def test_fingerprints(session, monkeypatch):
    await startup.record_fingerprints(session)
    assert await startup.key_checks(session) == {"switchboard_secret_key": "ok", "litellm_salt_key": "ok"}
    rows = (await session.execute(select(SystemMeta))).scalars().all()
    assert all(os.environ["LITELLM_SALT_KEY"] not in r.value for r in rows)

    s = get_settings()
    monkeypatch.setattr(s, "litellm_salt_key", type(s.litellm_salt_key)("sk-a-different-salt"))
    assert (await startup.key_checks(session))["litellm_salt_key"] == "changed"
    # Recording again never overwrites the original fingerprint.
    await startup.record_fingerprints(session)
    assert (await startup.key_checks(session))["litellm_salt_key"] == "changed"


@pytest.mark.live
async def test_live_fetchers():  # pragma: no cover - opt-in: pytest -m live
    """Fetches real model lists for every provider with LIVE_<ENV_KEY> set (e.g. LIVE_GROQ_API_KEY)."""
    import httpx

    from app.catalog.fetchers import fetch

    reg = load_registry()
    tried = 0
    async with httpx.AsyncClient() as c:
        for p in reg.api_providers():
            key = os.environ.get(f"LIVE_{p.env_key}")
            if key:
                tried += 1
                assert await fetch(c, p, key), p.id
    if not tried:
        pytest.skip("no LIVE_* keys set")
