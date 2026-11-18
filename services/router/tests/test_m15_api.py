"""M1.5 router API: pinned threads, export, clear all, Settings overrides, footer summary."""

import httpx
import pytest

from app.api import system
from app.models import Cost
from app.routing.health import cooldowns
from tests import fixtures as fx
from tests.conftest import ADMIN
from tests.test_chat import add_mistral, first, stack, turn  # noqa: F401  (stack is a fixture)


async def _threads(client):
    return (await client.get("/chat/threads", headers=ADMIN)).json()["threads"]


async def test_pin_sorts_first_and_keeps_updated_at(client, stack):  # noqa: F811
    a = first(await turn(client, text="first chat"), "start")["thread_id"]
    b = first(await turn(client, text="second chat"), "start")["thread_id"]
    assert [t["id"] for t in await _threads(client)][:2] == [b, a]
    before = next(t for t in await _threads(client) if t["id"] == a)["updated_at"]

    r = await client.patch(f"/chat/threads/{a}", json={"pinned": True}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["pinned"] is True
    rows = await _threads(client)
    assert rows[0]["id"] == a and rows[0]["pinned"] and rows[0]["updated_at"] == before

    r = await client.patch(f"/chat/threads/{a}", json={"title": "Renamed", "pinned": False}, headers=ADMIN)
    assert r.json()["title"] == "Renamed" and r.json()["pinned"] is False
    assert (await client.patch(f"/chat/threads/{a}", json={}, headers=ADMIN)).status_code == 422


async def test_export_json_and_markdown_skip_private_unless_asked(client, stack):  # noqa: F811
    await turn(client, text="public question")
    await turn(client, text="secret question", private=True)
    j = (await client.get("/chat/export", headers=ADMIN)).json()
    assert j["format"] == "switchboard.chats.v1"
    texts = [m["content"] for t in j["threads"] for m in t["messages"]]
    assert "public question" in texts and "secret question" not in texts
    assert all(not t["private"] for t in j["threads"])

    j = (await client.get("/chat/export?include_private=true", headers=ADMIN)).json()
    assert "secret question" in [m["content"] for t in j["threads"] for m in t["messages"]]

    r = await client.get("/chat/export?format=md", headers=ADMIN)
    assert r.headers["content-type"].startswith("text/markdown")
    assert r.text.startswith("# Switchboard chats") and "**You**" in r.text and "public question" in r.text


async def test_clear_all_needs_the_phrase(client, stack):  # noqa: F811
    await turn(client, text="one")
    bad = await client.request("DELETE", "/chat/threads", json={"confirm": "yes"}, headers=ADMIN)
    assert bad.status_code == 422 and await _threads(client)
    ok = await client.request("DELETE", "/chat/threads", json={"confirm": "delete all chats"}, headers=ADMIN)
    assert ok.status_code == 200 and ok.json()["deleted"] >= 1 and await _threads(client) == []


async def test_export_and_clear_require_admin(client):
    assert (await client.get("/chat/export")).status_code == 401
    assert (
        await client.request("DELETE", "/chat/threads", json={"confirm": "delete all chats"})
    ).status_code == 401
    assert (await client.put("/settings", json={"daily_cap_usd": 1})).status_code == 401


async def test_settings_override_rules_yaml_and_are_enforced(client, stack, session):  # noqa: F811
    s = (await client.get("/settings")).json()
    assert s["daily_cap_usd"] == s["defaults"]["daily_cap_usd"] and s["overridden"] == []

    r = await client.put("/settings", json={"daily_cap_usd": 0.5, "private_by_default": True}, headers=ADMIN)
    assert r.json()["daily_cap_usd"] == 0.5 and r.json()["private_by_default"] is True
    assert r.json()["overridden"] == ["daily_cap_usd", "private_by_default"]
    assert (await client.put("/settings", json={"max_cost_usd": -1}, headers=ADMIN)).status_code == 422

    # The engine uses the override: $0.60 spent today is over the new $0.50 cap.
    await add_mistral(session, stack)
    session.add(Cost(source="litellm", provider="mistral", model="x", cost_usd=0.60))
    await session.commit()
    b = first(await turn(client, text="hi", target="model:general"), "blocked")
    assert b["code"] == "budget_daily" and "$0.50" in b["reason"]

    # null removes the override: back to the rules.yaml cap ($1.00), so the same request runs.
    await client.put("/settings", json={"daily_cap_usd": None}, headers=ADMIN)
    ev = await turn(client, text="hi", target="model:general")
    assert not [e for e, _ in ev if e == "blocked"]


async def test_per_request_cap_lowers_rule_caps():
    from app.routing.rules import load_rules

    rs = load_rules().with_settings({"max_cost_usd": 0.01})
    assert rs.defaults.max_cost_usd == 0.01
    assert all(r.max_cost_usd is None or r.max_cost_usd <= 0.01 for r in rs.rules)


@pytest.fixture
def probes(mock_http):
    system._probe_cache.clear()
    mock_http.get("http://ollama.test/api/tags").respond(200, json=fx.OLLAMA_TAGS)
    mock_http.get("http://paperclip.test/api/health").mock(side_effect=httpx.ConnectError("refused"))


async def test_summary_spend_value_saved_quota_health(client, stack, probes, session):  # noqa: F811
    await turn(client, text="hi")  # Groq is free tier: $0 counted, list price kept
    body = (await client.get("/system/summary")).json()
    assert body["health"] == {
        "router": "ok",
        "litellm": "ok",
        "ollama": "ok",
        "paperclip": "down",
        "model_sync": body["health"]["model_sync"],
    }
    assert body["spend_today_usd"] == 0 and body["value_saved_usd"] > 0
    assert body["quota"]["status"] == "ok" and body["version"]

    cooldowns.set("model:fast", "rate_limited", "Rate limited (429)", 60)
    assert (await client.get("/system/summary")).json()["quota"]["status"] == "limited"
    cooldowns.clear()

    session.add(Cost(source="litellm", provider="mistral", model="x", cost_usd=5.0))
    await session.commit()
    q = (await client.get("/system/summary")).json()["quota"]
    assert q["status"] == "blocked" and q["daily_cap_used"] == 1.0
