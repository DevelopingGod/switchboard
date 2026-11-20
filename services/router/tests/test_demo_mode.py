"""The throwaway demo router (scripts/demo-reset.sh): it must never write to LiteLLM or refresh the
catalog (only the main router does), and its traffic is tagged so Metrics (M6) can exclude it."""

import asyncio
import json

import pytest
from sqlalchemy import select

from app import local_profile, sync
from app import main as app_main
from app.config import get_settings
from app.models import Request
from app.routing import classifier
from tests.test_chat import first, stack, turn  # noqa: F401  (stack is a fixture)


async def _noop(*_a, **_k):
    return 0


@pytest.fixture
def spies(monkeypatch):
    started: list[str] = []

    async def fake_sync(*_a, **_k):
        started.append("sync")

    async def fake_catalog(*_a, **_k):
        started.append("catalog")

    monkeypatch.setattr(app_main.sync, "run_forever", fake_sync)
    monkeypatch.setattr(app_main, "run_forever", fake_catalog)
    # the rest of the startup is not under test: no network, no DB writes
    for name in ("ensure_connections", "record_fingerprints", "import_env_keys"):
        monkeypatch.setattr(app_main, name, _noop)
    monkeypatch.setattr(local_profile, "init", _noop)
    monkeypatch.setattr(app_main.system, "refresh_profile_state", _noop)
    monkeypatch.setattr(app_main.cooldowns, "load", _noop)
    monkeypatch.setattr(classifier, "warm_up_in_background", lambda: None)
    monkeypatch.setattr(app_main, "load_registry", lambda: None)
    monkeypatch.setattr(get_settings(), "background_jobs", True)
    return started


@pytest.mark.parametrize(("enabled", "expected"), [(True, ["sync", "catalog"]), (False, [])])
async def test_sync_and_catalog_jobs_follow_the_flag(spies, monkeypatch, enabled, expected):
    monkeypatch.setattr(get_settings(), "router_sync_enabled", enabled)
    async with app_main.lifespan(app_main.app):
        await asyncio.sleep(0.05)
    assert sorted(spies) == sorted(expected)
    assert sync is app_main.sync  # same module the endpoints call


async def test_demo_traffic_is_tagged_everywhere(client, stack, session, monkeypatch):  # noqa: F811
    monkeypatch.setattr(get_settings(), "router_request_tag", "switchboard-demo")
    ev = await turn(client, text="What is the capital of France?")
    body = stack.stream_calls[-1]
    assert body["user"] == "switchboard-demo" and body["metadata"] == {"tags": ["switchboard-demo"]}
    req = await session.get(Request, first(ev, "start")["request_id"])
    assert req.decision_json["tag"] == "switchboard-demo"
    assert "switchboard-demo" not in json.dumps(first(ev, "done")["route"])


async def test_untagged_by_default(client, stack, session):  # noqa: F811
    ev = await turn(client, text="What is the capital of France?")
    body = stack.stream_calls[-1]
    assert "user" not in body and "metadata" not in body
    rid = first(ev, "start")["request_id"]
    req = (await session.execute(select(Request).where(Request.id == rid))).scalar_one()
    assert "tag" not in req.decision_json
