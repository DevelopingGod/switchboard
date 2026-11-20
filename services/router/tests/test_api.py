"""Connections API: admin auth, key add/test/remove, LiteLLM reconcile, secret hygiene, hostprobe-down."""

import logging

import pytest
from sqlalchemy import select, text

from app import secrets
from app.litellm_admin import LiteLLMAdmin
from app.models import ModelStats, ProviderSecret
from app.reconcile import reconcile
from tests import fixtures as fx
from tests.conftest import ADMIN

GROQ_KEY = "gsk_LIVEgroqKEYvalue0123456789"
CEREBRAS_KEY = "csk-cerebrasKEYvalue0123456789"
GROQ = "https://api.groq.com/openai/v1/models"
CEREBRAS = "https://api.cerebras.ai/v1/models"


@pytest.fixture
def providers_ok(mock_http):
    mock_http.get(GROQ).respond(200, json=fx.GROQ_MODELS)
    mock_http.get(CEREBRAS).respond(200, json=fx.CEREBRAS_MODELS)
    mock_http.get("http://ollama.test/api/tags").respond(200, json=fx.OLLAMA_TAGS)


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("PUT", "/connections/groq/key", {"api_key": GROQ_KEY}),
        ("DELETE", "/connections/groq/key", None),
        ("POST", "/connections/groq/test", None),
        ("POST", "/models/test", {"alias": "fast"}),
        ("POST", "/catalog/refresh", None),
        ("POST", "/connections/cli/refresh", None),
    ],
)
async def test_write_endpoints_require_admin_token(client, method, path, body):
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "admin-token-test-0123456789"}):
        r = await client.request(method, path, json=body, headers=headers)
        assert r.status_code == 401, (method, path, headers)


async def test_cors_only_portal_origin(client):
    pre = {"Access-Control-Request-Method": "PUT"}
    ok = await client.options("/connections/groq/key", headers={"Origin": "http://localhost:3000", **pre})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = await client.options("/connections/groq/key", headers={"Origin": "http://evil.example", **pre})
    assert "access-control-allow-origin" not in bad.headers


async def test_add_test_remove_key(client, litellm, providers_ok, hostprobe_up, session, caplog):
    caplog.set_level(logging.DEBUG)
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "connected" and body["key_last4"] == "6789"
    assert body["catalog"]["added"] == 4

    # Stored encrypted; registered as a LiteLLM credential; aliases deployed.
    row = await session.get(ProviderSecret, "groq")
    assert GROQ_KEY.encode() not in row.ciphertext
    assert litellm.credentials["sb-groq"] == {"api_key": GROQ_KEY}
    fast = litellm.deployments("fast")
    assert len(fast) == 1 and fast[0]["litellm_params"]["litellm_credential_name"] == "sb-groq"
    assert fast[0]["litellm_params"]["timeout"] == 25 and fast[0]["litellm_params"]["order"] == 1
    assert "api_key" not in fast[0]["litellm_params"]
    assert {d["model_name"] for d in litellm.deployments()} == {
        "fast",
        "local",
        "private",
        "local-code",
        "local-think",  # M4a: "Think harder" (the profile's thinking model)
        "groq/*",  # M2: any catalog model by name (model:groq/<id>)
        "ollama/*",
    }
    wild = litellm.deployments("groq/*")[0]["litellm_params"]
    assert wild["model"] == "groq/*" and wild["litellm_credential_name"] == "sb-groq"
    local_code = litellm.deployments("local-code")[0]["litellm_params"]
    assert local_code == {
        "model": "ollama_chat/qwen3:4b-instruct-2507-q4_K_M",
        "api_base": "os.environ/OLLAMA_API_BASE",
    }
    think = litellm.deployments("local-think")[0]["litellm_params"]
    assert think["model"] == "ollama_chat/qwen3:4b"

    r = await client.get("/connections")
    groq = next(p for p in r.json()["providers"] if p["provider"] == "groq")
    assert groq["status"] == "connected" and groq["key_last4"] == "6789" and groq["models_available"] == 3

    r = await client.post("/connections/groq/test", headers=ADMIN)
    assert r.json()["ok"] is True

    r = await client.get("/catalog", params={"provider": "groq", "tag": "code"})
    assert [m["model_id"] for m in r.json()["models"]] == ["openai/gpt-oss-120b"]

    r = await client.delete("/connections/groq/key", headers=ADMIN)
    assert r.status_code == 200 and r.json()["removed"] is True
    assert "sb-groq" not in litellm.credentials
    assert litellm.deployments("fast") == []
    session.expire_all()
    assert await session.get(ProviderSecret, "groq") is None
    r = await client.get("/connections")
    assert next(p for p in r.json()["providers"] if p["provider"] == "groq")["status"] == "no_key"

    # The key never appears in logs or in any table.
    assert GROQ_KEY not in caplog.text
    dump = (
        await session.execute(
            text("select coalesce(string_agg(t::text, ' '), '') from (select * from connections) t")
        )
    ).scalar_one()
    assert GROQ_KEY not in dump


async def test_bad_key_is_not_stored(client, litellm, mock_http, session):
    mock_http.get(GROQ).respond(401, json={"error": {"message": f"Invalid API Key {GROQ_KEY}"}})
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 400
    assert GROQ_KEY not in r.text
    assert await session.get(ProviderSecret, "groq") is None
    assert litellm.credentials == {}


async def test_cerebras_joins_fast_as_order_2(client, litellm, providers_ok, hostprobe_up):
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    await client.put("/connections/cerebras/key", json={"api_key": CEREBRAS_KEY}, headers=ADMIN)
    fast = sorted(litellm.deployments("fast"), key=lambda d: d["litellm_params"]["order"])
    assert [d["litellm_params"]["model"] for d in fast] == [
        "groq/openai/gpt-oss-120b",
        "cerebras/gpt-oss-120b",
    ]
    assert [d["litellm_params"]["order"] for d in fast] == [1, 2]
    assert len(litellm.deployments("cerebras")) == 1


async def test_reconcile_idempotent_and_leaves_manual_models(client, litellm, providers_ok, session):
    litellm.models["manual"] = {
        "model_name": "my-manual",
        "litellm_params": {"model": "x"},
        "model_info": {"id": "manual"},
    }
    await secrets.store_key(session, "groq", GROQ_KEY)
    await session.commit()
    admin = LiteLLMAdmin()
    first = await reconcile(session, admin)
    assert first["added"] and not first["removed"]
    second = await reconcile(session, admin)
    assert second["added"] == [] and second["removed"] == []
    assert "manual" in litellm.models
    # A changed spec (e.g. edited timeout) is replaced, not duplicated.
    dep = litellm.deployments("fast")[0]
    dep["model_info"]["sb_hash"] = "stale"
    third = await reconcile(session, admin)
    assert len(third["removed"]) == 1 and len(litellm.deployments("fast")) == 1
    await admin.aclose()


async def test_models_test_alias_and_direct(client, litellm, providers_ok, mock_http, session):
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    r = await client.post("/models/test", json={"alias": "fast"}, headers=ADMIN)
    assert r.json()["ok"] is True and litellm.chat_calls == ["fast"]
    assert r.json()["served_by"] == "groq/openai/gpt-oss-120b"

    chat = mock_http.post("https://api.groq.com/openai/v1/chat/completions").respond(
        200, json={"choices": [{"message": {"content": "pong"}}]}
    )
    r = await client.post(
        "/models/test", json={"provider": "groq", "model_id": "qwen/qwen3.8-27b"}, headers=ADMIN
    )
    assert r.json()["ok"] is True
    req = chat.calls.last.request
    assert req.headers["authorization"] == f"Bearer {GROQ_KEY}"
    assert litellm.chat_calls == ["fast"]  # direct test did not go through LiteLLM

    stats = (await session.execute(select(ModelStats))).scalars().all()
    assert {s.task_type for s in stats} == {"test"} and len(stats) == 2
    assert all(s.samples == 1 and s.last_ok for s in stats)

    r = await client.get("/catalog", params={"provider": "groq"})
    tested = [m for m in r.json()["models"] if m["test"]]
    assert len(tested) == 2


async def test_models_test_gemini_uses_header(client, litellm, mock_http, session):
    await secrets.store_key(session, "gemini", "AIzaTESTKEY0000000000000000")
    await session.commit()
    route = mock_http.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
    ).respond(200, json={"candidates": []})
    r = await client.post(
        "/models/test", json={"provider": "gemini", "model_id": "gemini-3.5-flash"}, headers=ADMIN
    )
    assert r.json()["ok"] is True
    assert route.calls.last.request.headers["x-goog-api-key"] == "AIzaTESTKEY0000000000000000"
    assert "AIza" not in str(route.calls.last.request.url)


async def test_router_healthy_when_hostprobe_down(client, hostprobe_down):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "db": "ok",
        "litellm": "ok",
        "hostprobe": "down",
        "rules": "ok (11 rules, 11 classifier routes)",
        "fault_injection": False,
        "quota_test_limits": None,
    }
    r = await client.get("/connections")
    assert r.status_code == 200 and r.json()["hostprobe"] == "down"
    clis = [p for p in r.json()["providers"] if p["kind"] == "cli"]
    assert len(clis) == 5 and {c["status"] for c in clis} == {"unknown"}


async def test_cli_rows_from_hostprobe(client, hostprobe_up):
    r = await client.get("/connections/cli")
    clis = r.json()["clis"]
    assert clis["claude-code"]["status"] == "windows_only"
    assert clis["codex"]["status"] == "logged_in" and clis["codex"]["version"] == "0.98.1"
    assert clis["gemini-cli"]["status"] == "logged_out"
    assert clis["grok-build"]["status"] == "not_installed"
    # Where the binary lives and whether a new terminal can find it, for the "add to PATH" step.
    codex = clis["codex"]
    assert (codex["bin_path"], codex["bin_dir"], codex["on_user_path"]) == (
        "~/.local/bin/codex",
        "~/.local/bin",
        False,
    )
    assert clis["grok-build"]["bin_path"] is None and clis["grok-build"]["on_user_path"] is None


async def test_hostprobe_token_sent(client, mock_http):
    route = mock_http.get("http://hostprobe.test/cli").respond(200, json={"clis": {}})
    await client.get("/connections/cli")
    assert route.calls.last.request.headers["x-probe-token"] == "probe-token-test-0123456789"


def test_redaction_patterns():
    secrets.remember("my-custom-secret-value")
    msg = (
        "failed my-custom-secret-value gsk_abcdefgh12345 AIzaSyA-0123456789abcdefghijk Bearer abc.def-123456"
    )
    clean = secrets.redact(msg)
    for s in ("my-custom-secret-value", "gsk_abcdefgh12345", "AIzaSyA", "abc.def-123456"):  # gitleaks:allow
        assert s not in clean
    secrets.forget("my-custom-secret-value")


async def test_unknown_provider_and_cli_key(client):
    assert (
        await client.put("/connections/nope/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    ).status_code == 404
    r = await client.put("/connections/codex/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 400


async def test_litellm_failure_reported(client, litellm, providers_ok):
    litellm.broken = True
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 502 and GROQ_KEY not in r.text
