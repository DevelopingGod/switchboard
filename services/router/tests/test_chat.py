"""Chat API (M2): streaming, fallbacks with reasons, private stays local, caps, logging, feedback."""

import json
from decimal import Decimal

import pytest
from sqlalchemy import select

from app import secrets
from app.chat import service
from app.config import get_settings
from app.litellm_admin import LiteLLMAdmin
from app.models import Connection, Cost, Message, ModelCatalog, ModelStats, Request, Thread
from app.reconcile import reconcile
from app.routing.health import cooldowns
from tests.conftest import ADMIN

LOCAL = {"local", "private", "local-code"}


def parse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        ev, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                ev = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if ev:
            out.append((ev, data))
    return out


def names(events):
    return [e for e, _ in events]


def first(events, name):
    return next(d for e, d in events if e == name)


async def turn(client, path="/chat/send", **body):
    r = await client.post(path, json=body, headers=ADMIN)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/event-stream")
    return parse(r.text)


@pytest.fixture
async def stack(litellm, session):
    """Groq + Gemini keyed, Ollama local, catalog rows with prices, reconciled into the fake."""
    cooldowns.clear()
    await secrets.store_key(session, "groq", "gsk_test_000000000000000000006789")  # gitleaks:allow
    await secrets.store_key(session, "gemini", "AIza_test_00000000000000000000001")  # gitleaks:allow
    session.add(Connection(provider="ollama", kind="local", status="connected", meta_json={}))
    rows = [
        (
            "groq",
            "openai/gpt-oss-120b",
            ["chat", "code", "reasoning", "fast"],
            {"input_per_1m": 0.15, "output_per_1m": 0.6},
            "no-training",
        ),
        ("gemini", "gemini-3.1-flash-lite", ["chat", "fast"], {}, "may-train"),
        ("ollama", "qwen3:4b", ["chat", "reasoning"], {}, "local"),
        ("ollama", "qwen2.5-coder:3b", ["chat", "code"], {}, "local"),
        (
            "mistral",
            "mistral-small-latest",
            ["chat"],
            {"input_per_1m": 0.2, "output_per_1m": 0.6},
            "may-train",
        ),
    ]
    for provider, mid, tags, prices, privacy in rows:
        session.add(
            ModelCatalog(
                provider=provider,
                model_id=mid,
                tags_json=tags,
                prices_json=prices,
                privacy=privacy,
                tag_source="curated",
                free=True,
                meta_json={},
            )
        )
    await session.commit()
    admin = LiteLLMAdmin()
    await reconcile(session, admin)
    await admin.aclose()
    yield litellm
    cooldowns.clear()


async def add_mistral(session, litellm):
    await secrets.store_key(session, "mistral", "mistral_test_0000000000000000000001")  # gitleaks:allow
    await session.commit()
    admin = LiteLLMAdmin()
    await reconcile(session, admin)
    await admin.aclose()


async def test_chat_requires_admin(client):
    assert (await client.get("/chat/threads")).status_code == 401
    assert (await client.post("/chat/send", json={"text": "hi"})).status_code == 401


async def test_send_streams_and_logs_everything(client, stack, session):
    ev = await turn(client, text="What is the capital of France?")
    assert names(ev)[0] == "start" and "route" in names(ev) and "delta" in names(ev)
    assert names(ev).index("done") > names(ev).index("delta")
    start, done = first(ev, "start"), first(ev, "done")
    assert first(ev, "route")["target"] == "model:fast"
    assert "".join(d["text"] for e, d in ev if e == "delta") == "Hello there!"
    assert done["content"] == "Hello there!" and done["status"] == "done"
    chip = done["route"]
    assert chip["rule"] == "default" and chip["label"].startswith("Groq")
    assert chip["model"] == "groq/openai/gpt-oss-120b" and chip["tokens_in"] == 10 and chip["tokens_out"] == 5
    assert len(chip["reasons"]) == 3 and chip["runner_up"]
    assert {s["target"] for s in chip["skipped"]} == {"model:explore"}

    req = await session.get(Request, start["request_id"])
    assert (
        req.status == "ok" and req.kind == "chat" and req.rule_id == "default" and req.target == "model:fast"
    )
    assert req.model == "groq/openai/gpt-oss-120b" and req.latency_ms is not None and req.ttft_ms is not None
    assert req.prompt_hash and "France" not in json.dumps(req.decision_json)  # hash only, no prompt text
    assert {f["code"] for f in req.fallbacks_tried_json} == {"not_connected"}
    cost = (await session.execute(select(Cost).where(Cost.request_id == req.id))).scalar_one()
    assert (cost.tokens_in, cost.tokens_out, cost.source, cost.provider) == (10, 5, "litellm", "groq")
    # Groq is free tier: $0 toward caps, list price kept as the "value"
    assert cost.cost_usd == 0 and cost.list_price_usd == Decimal("0.0012")
    stats = (await session.execute(select(ModelStats).where(ModelStats.task_type == "chat"))).scalar_one()
    assert stats.samples == 1 and stats.p50_ms is not None
    # streamed with router-owned fallbacks
    body = stack.stream_calls[0]
    assert body["disable_fallbacks"] is True and body["stream_options"] == {"include_usage": True}


async def test_thinking_streams_but_is_never_stored(client, stack, session):
    stack.script["fast"] = "think-tags"
    ev = await turn(client, text="hi")
    thinking = "".join(d["text"] for e, d in ev if e == "thinking")
    assert "Let me think" in thinking and "secret plan" in thinking
    done = first(ev, "done")
    assert "secret plan" not in done["content"] and "Let me think" not in done["content"]
    assert done["route"]["thinking_ms"] is not None
    msgs = (await session.execute(select(Message))).scalars().all()
    assert all("secret plan" not in m.content and "Let me think" not in m.content for m in msgs)


async def test_429_falls_back_and_explains(client, stack, session):
    stack.script["fast"] = "429"
    ev = await turn(client, text="hello")
    fb = first(ev, "fallback")
    assert fb["target"] == "model:fast" and fb["code"] == "rate_limited" and "429" in fb["reason"]
    assert fb["next"].startswith("Google AI Studio")
    chip = first(ev, "done")["route"]
    assert chip["target"] == "model:smart-free"
    assert any(s["code"] == "rate_limited" for s in chip["skipped"])
    assert any("Fallback" in r and "429" in r for r in chip["reasons"])
    # The next request skips the cooling-down target without calling it.
    stack.stream_calls.clear()
    ev2 = await turn(client, text="again")
    assert stack.streamed_models()[0] == "smart-free"
    skip = next(s for s in first(ev2, "done")["route"]["skipped"] if s["target"] == "model:fast")
    assert skip["code"] == "cooldown" and "cooling down" in skip["reason"]
    req = await session.get(Request, first(ev, "start")["request_id"])
    assert any(f["code"] == "rate_limited" for f in req.fallbacks_tried_json)


@pytest.mark.parametrize("mode", ["402", "402-wrapped"])
async def test_credit_limit_falls_back_with_a_clear_reason(client, stack, mode):
    stack.script["fast"] = mode
    ev = await turn(client, text="hello")
    fb = first(ev, "fallback")
    assert fb["target"] == "model:fast" and fb["code"] == "credit_limit"
    assert "Credit limit reached" in fb["reason"] and ":free" in fb["reason"]
    chip = first(ev, "done")["route"]
    assert chip["target"] == "model:smart-free"
    assert any("Credit limit reached" in s["reason"] for s in chip["skipped"] if s["code"] == "credit_limit")
    # long cooldown: the next request skips it without calling it, and still says why
    assert cooldowns.remaining("model:fast") > 600
    stack.stream_calls.clear()
    ev2 = await turn(client, text="again")
    assert stack.streamed_models()[0] == "smart-free"
    skip = next(s for s in first(ev2, "done")["route"]["skipped"] if s["target"] == "model:fast")
    assert skip["code"] == "cooldown" and "Credit limit reached" in skip["reason"]


async def test_429_is_still_a_rate_limit_not_a_credit_limit(client, stack):
    stack.script["fast"] = "429"
    assert first(await turn(client, text="hello"), "fallback")["code"] == "rate_limited"


async def _cerebras(session):
    await secrets.store_key(session, "cerebras", "csk-test-00000000000000000000000001")  # gitleaks:allow
    session.add(
        ModelCatalog(
            provider="cerebras",
            model_id="gpt-oss-120b",
            tags_json=["chat", "fast"],
            prices_json={},
            privacy="no-training",
            tag_source="curated",
            free=True,
            meta_json={},
        )
    )
    await session.commit()
    admin = LiteLLMAdmin()
    await reconcile(session, admin)
    await admin.aclose()


async def test_cerebras_credits_are_tracked_and_routing_stops_at_zero(client, stack, session, hostprobe_down):
    await _cerebras(session)
    assert stack.deployments("cerebras") != []
    row = next(
        p for p in (await client.get("/connections")).json()["providers"] if p["provider"] == "cerebras"
    )
    assert row["credits"] == {"starting_usd": None}  # no balance entered yet: nothing is blocked

    r = await client.put("/connections/cerebras/credits", json={"starting_usd": 1.0}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["credits"]["remaining_usd"] == 1.0
    assert (
        await client.put("/connections/groq/credits", json={"starting_usd": 1}, headers=ADMIN)
    ).status_code == 400
    assert (
        await client.put("/connections/cerebras/credits", json={"starting_usd": -1}, headers=ADMIN)
    ).status_code == 422

    stack.usage_cost = 0.6  # list price per call
    ev = await turn(client, text="hi", target="model:cerebras")
    chip = first(ev, "done")["route"]
    assert chip["provider"] == "cerebras" and chip["cost_usd"] == 0  # credits never touch the daily cap
    row = next(
        p for p in (await client.get("/connections")).json()["providers"] if p["provider"] == "cerebras"
    )
    assert row["credits"]["spent_usd"] == pytest.approx(0.6) and row["credits"][
        "remaining_usd"
    ] == pytest.approx(0.4)
    assert not row["credits"]["exhausted"] and stack.deployments("cerebras") != []

    await turn(client, text="again", target="model:cerebras")  # 1.2 of 1.0 spent: used up
    row = next(
        p for p in (await client.get("/connections")).json()["providers"] if p["provider"] == "cerebras"
    )
    assert row["credits"]["remaining_usd"] == 0 and row["credits"]["exhausted"]
    assert stack.deployments("cerebras") == []  # LiteLLM can no longer pick it, even as a failover
    assert not [d for d in stack.deployments("fast") if "cerebras" in d["litellm_params"]["model"]]

    stack.stream_calls.clear()
    ev = await turn(client, text="third", target="model:cerebras")
    assert stack.stream_calls == []  # no call was made
    err = first(ev, "error")
    skip = next(s for s in err["skipped"] if s["target"] == "model:cerebras")
    assert skip["code"] == "credits" and "used up" in skip["reason"] and "$1.00" in skip["reason"]
    # auto routing keeps working through Groq
    ev = await turn(client, text="and auto")
    assert first(ev, "done")["route"]["provider"] == "groq"

    # entering a new balance turns it back on
    await client.put("/connections/cerebras/credits", json={"starting_usd": 5}, headers=ADMIN)
    assert stack.deployments("cerebras") != []
    ev = await turn(client, text="back", target="model:cerebras")
    assert first(ev, "done")["route"]["provider"] == "cerebras"


async def test_timeout_falls_back(client, stack):
    stack.script["fast"] = "timeout"
    ev = await turn(client, text="hello")
    assert first(ev, "fallback")["code"] == "timeout"
    assert first(ev, "done")["route"]["target"] == "model:smart-free"


async def test_midstream_error_ends_reply_without_duplicate(client, stack, session):
    stack.script["fast"] = "midstream"
    ev = await turn(client, text="hello")
    assert "fallback" not in names(ev)
    done = first(ev, "done")
    assert done["status"] == "error" and done["content"] == "Hello"
    assert len(stack.stream_calls) == 1


async def test_private_provably_stays_local(client, stack, session):
    """Every LiteLLM call for a private request is an Ollama deployment, even when local fails,
    with a cloud model picked, and for later non-private messages in the same thread (sticky)."""
    reg_local = {"ollama_chat/qwen3:4b", "ollama_chat/qwen2.5-coder:3b"}

    def assert_all_local():
        assert stack.stream_calls
        for b in stack.stream_calls:
            assert b["model"] in LOCAL or b["model"].startswith("ollama/"), b["model"]
            assert stack.resolve(b["model"]) in reg_local

    ev = await turn(client, text="my bank details", private=True, target="model:fast")
    assert first(ev, "start")["private"] and first(ev, "done")["route"]["local"]
    assert_all_local()
    tid = first(ev, "start")["thread_id"]

    stack.stream_calls.clear()
    stack.script["local"] = "500"
    ev = await turn(client, text="more private things", private=True)
    assert_all_local()
    assert first(ev, "done")["status"] == "error"  # no cloud fallback, ever

    stack.stream_calls.clear()
    stack.script.pop("local")
    ev = await turn(client, text="now not private?", thread_id=tid, private=False)
    assert first(ev, "start")["private"]
    assert_all_local()
    thread = await session.get(Thread, __import__("uuid").UUID(tid))
    await session.refresh(thread)
    assert thread.private


async def test_slash_private_makes_thread_private(client, stack, session):
    ev = await turn(client, text="/private my diary")
    assert first(ev, "start")["private"] and stack.streamed_models() == ["local"]


async def test_manual_pick_and_specific_model(client, stack):
    ev = await turn(client, text="hi", target="model:smart-free")
    assert first(ev, "done")["route"]["rule"] == "manual" and stack.streamed_models() == ["smart-free"]
    stack.stream_calls.clear()
    ev = await turn(client, text="hi", target="model:groq/openai/gpt-oss-120b")
    assert stack.streamed_models() == ["groq/openai/gpt-oss-120b"]
    assert first(ev, "done")["route"]["model"] == "groq/openai/gpt-oss-120b"


async def test_manual_pick_does_not_silently_switch(client, stack):
    stack.script["smart-free"] = "429"
    ev = await turn(client, text="hi", target="model:smart-free")
    assert first(ev, "fallback")["next"] is None
    assert first(ev, "done")["status"] == "error" and stack.streamed_models() == ["smart-free"]


@pytest.mark.parametrize(
    ("text", "model", "rule"),
    [
        ("/chat hi", "fast", "default"),
        ("/code reverse a list in python", "fast", "code-light"),
        ("/research vector databases", "smart-free", "research"),
        ("/bulk tidy these notes", "fast", "bulk"),
        ("/private secret", "local", "private"),
    ],
)
async def test_slash_commands_route(client, stack, text, model, rule):
    ev = await turn(client, text=text)
    assert stack.streamed_models() == [model] and first(ev, "done")["route"]["rule"] == rule
    assert not stack.stream_calls[0]["messages"][-1]["content"].startswith("/")


async def test_image_and_video_are_studio_notices(client, stack, session):
    for text, kind in [("/image a red fox", "image"), ("Make a video of waves", "video")]:
        ev = await turn(client, text=text)
        assert first(ev, "notice")["kind"] == kind
        req = await session.get(Request, first(ev, "start")["request_id"])
        assert req.kind == "media" and req.status == "unavailable"
    assert stack.stream_calls == []


async def test_job_like_request_answers_in_chat_with_hint(client, stack):
    ev = await turn(client, text="Fix the failing tests in the repo switchboard")
    assert first(ev, "start")["job_suggested"] and first(ev, "done")["route"]["job_suggested"]
    assert first(ev, "done")["route"]["rule"] == "code-heavy"
    agents = [s for s in first(ev, "done")["route"]["skipped"] if s["code"] == "agent"]
    assert agents and all("M4" in s["reason"] for s in agents)


async def test_daily_cap_blocks_with_clear_message(client, stack, session):
    await add_mistral(session, stack)
    session.add(Cost(source="litellm", provider="mistral", model="x", cost_usd=1.25))
    await session.commit()
    ev = await turn(client, text="hi", target="model:general")
    b = first(ev, "blocked")
    assert b["code"] == "budget_daily" and "$1.00" in b["reason"] and b["spent_today"] == 1.25
    assert first(ev, "done")["status"] == "blocked" and stack.stream_calls == []
    req = await session.get(Request, first(ev, "start")["request_id"])
    assert req.status == "blocked"
    # Free tier still works on the same day.
    ev = await turn(client, text="hi")
    assert first(ev, "done")["status"] == "done"


async def test_free_tier_never_counts_toward_daily_cap(client, stack, session):
    stack.usage_cost = 0.9  # LiteLLM reports a list price for Groq and Gemini…
    for target in ("model:fast", "model:smart-free", "model:fast"):
        ev = await turn(client, text="hi", target=target)
        assert first(ev, "done")["route"]["cost_usd"] == 0
    costs = (await session.execute(select(Cost))).scalars().all()
    assert len(costs) == 3 and all(c.cost_usd == 0 and c.list_price_usd == Decimal("0.9") for c in costs)
    from app.routing.context import spent_today

    assert await spent_today(session) == 0.0  # …but $2.70 of "value" never blocks anything
    # A paid (non-free-tier) call does count.
    await add_mistral(session, stack)
    stack.usage_cost = 0.3
    await turn(client, text="hi", target="model:general")
    assert await spent_today(session) == pytest.approx(0.3)


async def test_stop_keeps_partial_answer(client, stack, session):
    async def hook(i):
        if i == 1:
            for ev in list(service.active.values()):
                ev.set()

    stack.on_stream_chunk = hook
    ev = await turn(client, text="tell me a story")
    done = first(ev, "done")
    assert done["status"] == "stopped" and done["content"] == "Hello"
    req = await session.get(Request, first(ev, "start")["request_id"])
    assert req.status == "stopped"


async def test_stop_endpoint(client, stack):
    r = await client.post("/chat/requests/999/stop", headers=ADMIN)
    assert r.json() == {"stopped": False, "detail": "not streaming"}


async def test_regenerate_and_edit_last(client, stack, session):
    ev = await turn(client, text="first question")
    tid = first(ev, "start")["thread_id"]
    stack.answer = "Second answer"
    ev = await turn(client, f"/chat/threads/{tid}/regenerate")
    assert first(ev, "done")["content"] == "Second answer"
    r = await client.get(f"/chat/threads/{tid}", headers=ADMIN)
    msgs = r.json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"] and msgs[1]["content"] == "Second answer"

    stack.answer = "Edited answer"
    ev = await turn(client, f"/chat/threads/{tid}/edit-last", text="better question")
    msgs = (await client.get(f"/chat/threads/{tid}", headers=ADMIN)).json()["messages"]
    assert [m["content"] for m in msgs] == ["better question", "Edited answer"]


async def test_title_from_local_model_then_rename(client, stack, session):
    ev = await turn(client, text="how do I center a div in CSS when the parent is flex?")
    assert first(ev, "start")["title"] == "how do I center a div…"
    t = first(ev, "title")
    assert t["title"] == "Centering a div in CSS" and t["source"] == "local"
    # M3a: the local profile's tasks model writes it through Ollama, thinking off; never the cloud
    call = next(c for c in stack.ollama.calls if c["messages"][0]["content"].startswith("Write a title"))
    assert call["model"] == "llama3.2:3b" and call["think"] is False
    assert not stack.chat_calls
    tid = t["thread_id"]
    r = await client.patch(f"/chat/threads/{tid}", json={"title": "CSS notes"}, headers=ADMIN)
    assert r.json()["title"] == "CSS notes" and r.json()["title_source"] == "user"
    await turn(client, text="follow-up", thread_id=tid)
    threads = (await client.get("/chat/threads", headers=ADMIN)).json()["threads"]
    assert threads[0]["title"] == "CSS notes"


async def test_title_falls_back_to_first_words(client, stack):
    stack.ollama.title_status = 500
    ev = await turn(client, text="one two three four five six seven eight")
    assert "title" not in names(ev)
    threads = (await client.get("/chat/threads", headers=ADMIN)).json()["threads"]
    assert threads[0]["title"] == "one two three four five six…" and threads[0]["title_source"] == "words"


async def test_feedback_updates_model_stats(client, stack, session):
    ev = await turn(client, text="hi")
    mid = first(ev, "done")["message_id"]

    async def stats():
        q = select(ModelStats).where(ModelStats.task_type == "chat")
        row = (await session.execute(q)).scalar_one()
        await session.refresh(row)
        return row.thumbs_up, row.thumbs_down

    for value, want in [("up", (1, 0)), ("up", (1, 0)), ("down", (0, 1)), (None, (0, 0))]:
        r = await client.post(f"/chat/messages/{mid}/feedback", json={"value": value}, headers=ADMIN)
        assert r.status_code == 200
        assert await stats() == want
    msgs = (await client.get(f"/chat/threads/{first(ev, 'start')['thread_id']}", headers=ADMIN)).json()
    assert msgs["messages"][1]["feedback"] is None


async def test_targets_for_picker(client, stack):
    r = await client.get("/chat/targets", headers=ADMIN)
    data = r.json()
    aliases = {a["alias"]: a for a in data["aliases"]}
    assert aliases["fast"]["available"] and not aliases["general"]["available"]
    assert "Mistral" in aliases["general"]["reason"] and "private" not in aliases
    assert aliases["local"]["local"] and aliases["fast"]["free_tier"]
    providers = {p["provider"]: p for p in data["providers"]}
    assert set(providers) == {"groq", "gemini", "ollama"}  # mistral not keyed
    assert providers["groq"]["models"][0]["target"] == "model:groq/openai/gpt-oss-120b"
    assert data["preset"] == "balanced"


async def test_dry_run(client, stack):
    r = await client.post("/route/dry-run", json={"text": "/code reverse a list"}, headers=ADMIN)
    d = r.json()
    assert d["rule"] == "code-light" and d["chosen"]["target"] == "model:fast" and d["reasons"]
    assert stack.stream_calls == []


async def test_fault_injection_is_off_by_default(client, stack):
    r = await client.post(
        "/chat/send", json={"text": "hi", "fault": {"target": "model:fast", "kind": "429"}}, headers=ADMIN
    )
    assert r.status_code == 400 and "fault injection is off" in r.text


async def test_fault_injection_429_when_enabled(client, stack, monkeypatch):
    monkeypatch.setattr(get_settings(), "router_fault_injection", True)
    ev = await turn(client, text="hi", fault={"target": "model:fast", "kind": "429"})
    assert first(ev, "fallback")["code"] == "rate_limited" and "injected" in first(ev, "fallback")["reason"]
    assert stack.streamed_models() == ["smart-free"]  # the 429 never reached a provider


async def test_unknown_thread_404(client, stack):
    r = await client.post(
        "/chat/send", json={"text": "hi", "thread_id": "00000000-0000-0000-0000-000000000000"}, headers=ADMIN
    )
    assert r.status_code == 404
