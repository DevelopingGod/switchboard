"""Self-healing (M1.5): idempotent LiteLLM writes, background resync, plain errors, Status view data."""

import asyncio

import httpx
import pytest

from app import db, sync
from app.litellm_admin import MANAGED_BY, LiteLLMAdmin, deployment_id
from app.reconcile import drift, reconcile
from tests import fixtures as fx
from tests.conftest import ADMIN

GROQ_KEY = "gsk_LIVEgroqKEYvalue0123456789"  # gitleaks:allow
GROQ_KEY_2 = "gsk_NEWgroqKEYvalue9876543210"  # gitleaks:allow
GROQ = "https://api.groq.com/openai/v1/models"


@pytest.fixture
def providers_ok(mock_http):
    mock_http.get(GROQ).respond(200, json=fx.GROQ_MODELS)
    mock_http.get("http://ollama.test/api/tags").respond(200, json=fx.OLLAMA_TAGS)


async def _until(cond, timeout=5.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


def _names(fake) -> set[str]:
    return {m["model_name"] for m in fake.models.values()}


# --- 1. idempotent writes -------------------------------------------------------------------------


async def test_replacing_a_key_survives_a_deployment_litellm_already_lost(client, litellm, providers_ok):
    """The real bug: replacing the OpenRouter key failed with "Model with id=… not found in db"."""
    assert (
        await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    ).status_code == 200
    # LiteLLM still lists a managed deployment that its DB no longer has (stale cache / a race).
    phantom = {
        "model_name": "fast",
        "litellm_params": {"model": "groq/old"},
        "model_info": {"id": "gone-123", "managed_by": MANAGED_BY, "sb_key": "fast|groq|old", "sb_hash": "x"},
    }
    real_info = litellm.model_info
    litellm.model_info = lambda req: httpx.Response(200, json={"data": [*litellm.models.values(), phantom]})
    try:
        r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY_2}, headers=ADMIN)
    finally:
        litellm.model_info = real_info
    assert r.status_code == 200, r.text
    assert "fast" in _names(litellm)


async def test_expanded_wildcard_rows_are_one_deployment(client, litellm, providers_ok, session):
    """LiteLLM lists `groq/*` once per Groq model, all with one id. That is one deployment, never a
    duplicate to delete (this deleted every wildcard on startup and broke OpenRouter key replace)."""
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert "groq/*" in _names(litellm)
    admin = LiteLLMAdmin()
    try:
        assert (await reconcile(session, admin))["removed"] == []
        assert (await reconcile(session, admin))["removed"] == []
        assert await drift(session, admin) == {"missing": [], "stale": [], "missing_credentials": []}
    finally:
        await admin.aclose()
    assert "groq/*" in _names(litellm)
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY_2}, headers=ADMIN)  # replace
    assert r.status_code == 200 and "groq/*" in _names(litellm)


async def test_delete_of_missing_model_and_credential_is_success(litellm):
    admin = LiteLLMAdmin()
    try:
        await admin.delete_model("never-existed")  # 400 "not found in db" -> success
        await admin.delete_credential("groq")  # 404 -> success
    finally:
        await admin.aclose()


async def test_create_of_existing_id_becomes_update(litellm):
    admin = LiteLLMAdmin()
    try:
        info = {"sb_key": "fast|groq|m", "provider": "groq"}
        await admin.add_model("fast", {"model": "groq/m", "timeout": 10}, info)
        await admin.add_model("fast", {"model": "groq/m", "timeout": 25}, info)  # 500 on create -> PATCH
    finally:
        await admin.aclose()
    assert list(litellm.models) == [deployment_id("fast|groq|m")]
    assert litellm.models[deployment_id("fast|groq|m")]["litellm_params"]["timeout"] == 25


async def test_concurrent_reconciles_do_not_race(client, litellm, providers_ok, session):
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    litellm.models.clear()
    admin = LiteLLMAdmin()
    try:
        async with db.sessionmaker()() as s2:
            await asyncio.gather(reconcile(session, admin), reconcile(s2, admin))
        assert await drift(session, admin) == {"missing": [], "stale": [], "missing_credentials": []}
    finally:
        await admin.aclose()
    keys = [m["model_info"]["sb_key"] for m in litellm.models.values()]
    assert len(keys) == len(set(keys))  # no duplicates


# --- 2. auto-resync ----------------------------------------------------------------------------------


@pytest.fixture
async def background(litellm, monkeypatch):
    """The real background loop, with fast timings."""
    monkeypatch.setattr(sync, "BACKOFF_START_S", 0.02)
    monkeypatch.setattr(sync, "BACKOFF_MAX_S", 0.1)
    sync.reset()
    admin = LiteLLMAdmin()
    task = asyncio.create_task(
        sync.run_forever(db.sessionmaker(), admin, full_every_s=3600, check_every_s=0.05)
    )
    yield admin
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await admin.aclose()


async def test_litellm_restart_mid_test_resyncs_without_user_action(
    client, litellm, providers_ok, background
):
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    await _until(lambda: sync.state.status == "ok" and "fast" in _names(litellm))
    before = _names(litellm)

    litellm.down = True  # LiteLLM stops ...
    await _until(lambda: sync.state.litellm_up is False)
    litellm.restart(wipe=True)  # ... and comes back with an empty DB
    await _until(lambda: _names(litellm) == before and "sb-groq" in litellm.credentials)
    assert sync.state.status == "ok" and sync.state.last_reason == "LiteLLM came back (restart)"


async def test_missing_deployment_is_restored_by_the_drift_check(client, litellm, providers_ok, background):
    await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    await _until(lambda: sync.state.status == "ok" and "fast" in _names(litellm))
    victim = next(k for k, m in litellm.models.items() if m["model_name"] == "fast")
    del litellm.models[victim]  # someone deleted it in the LiteLLM UI
    await _until(lambda: "fast" in _names(litellm))
    assert sync.state.last_reason.startswith("LiteLLM differs")


async def test_chat_seeing_a_missing_deployment_requests_a_sync(litellm):
    from app.chat.dispatch import classify

    sync.reset()
    e = classify(400, '{"error": {"message": "Invalid model name passed in model=fast"}}', None)
    assert e.code == "not_connected" and sync._wake.is_set()
    assert sync._pending_reason == "chat found a deployment missing in LiteLLM"


async def test_failures_retry_with_backoff_until_success(litellm, providers_ok, background):
    litellm.broken = True
    await _until(lambda: sync.state.status == "retrying" and sync.state.next_retry_at is not None)
    assert sync.state.last_error and "boom" in sync.state.last_error
    litellm.broken = False
    await _until(lambda: sync.state.status == "ok")
    assert sync.state.last_error is None and "local" in _names(litellm)


# --- 3. plain errors + Retry sync -----------------------------------------------------------------------


async def test_registration_failure_is_plain_and_retry_sync_fixes_it(
    client, litellm, providers_ok, hostprobe_down
):
    litellm.broken = True
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 502
    d = r.json()["detail"]
    assert d["code"] == "gateway_sync" and "retrying automatically" in d["message"]
    assert "boom" in d["detail"] and GROQ_KEY not in r.text  # raw only under detail; never the key

    row = next(p for p in (await client.get("/connections")).json()["providers"] if p["provider"] == "groq")
    assert row["sync_error"]

    litellm.broken = False
    r = await client.post("/connections/groq/resync", headers=ADMIN)
    assert r.status_code == 200 and "fast" in _names(litellm)
    row = next(p for p in (await client.get("/connections")).json()["providers"] if p["provider"] == "groq")
    assert "sync_error" not in row


async def test_bad_key_is_a_coded_error(client, litellm, mock_http):
    mock_http.get(GROQ).respond(401, json={"error": {"message": "Invalid API Key"}})
    r = await client.put("/connections/groq/key", json={"api_key": GROQ_KEY}, headers=ADMIN)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "key_rejected"


async def test_resync_requires_admin(client):
    for path in ("/system/resync", "/connections/groq/resync"):
        assert (await client.post(path)).status_code == 401


# --- 4. Status view data -----------------------------------------------------------------------------------


async def test_components_report_state_and_fix(client, litellm, mock_http, hostprobe_down):
    from app.api import system

    system._probe_cache.clear()
    mock_http.get("http://ollama.test/api/tags").respond(200, json=fx.OLLAMA_TAGS)
    mock_http.get("http://paperclip.test/api/health").mock(side_effect=httpx.ConnectError("refused"))
    body = (await client.get("/system/components")).json()
    by = {c["id"]: c for c in body["components"]}
    assert body["status"] == "down"
    assert by["router"]["status"] == by["database"]["status"] == by["litellm"]["status"] == "ok"
    assert by["ollama"]["status"] == "ok"
    assert (by["paperclip"]["status"], by["paperclip"]["fix"]) == ("down", "start_paperclip")
    assert (by["hostprobe"]["status"], by["hostprobe"]["fix"]) == ("down", "start_hostprobe")
    assert by["model_sync"]["fix"] == "resync"  # never synced in this test

    litellm.down = True
    system._probe_cache.clear()
    by = {c["id"]: c for c in (await client.get("/system/components")).json()["components"]}
    assert (by["litellm"]["status"], by["litellm"]["fix"]) == ("down", "start_docker")


async def test_resync_endpoint(client, litellm, providers_ok):
    r = await client.post("/system/resync", headers=ADMIN)
    assert r.status_code == 200 and r.json()["sync"]["status"] == "ok"
    assert "local" in _names(litellm)
    litellm.models.clear()
    litellm.broken = True
    r = await client.post("/system/resync", headers=ADMIN)
    assert r.status_code == 502 and r.json()["detail"]["code"] == "gateway_sync"
