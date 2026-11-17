"""Onboarding state, goal mapping, per-deployment retries and the CLI install proxy (hostprobe mocked)."""

import json

import pytest

from app.reconcile import deployment_spec
from app.registry import AliasDeployment, load_registry
from tests.conftest import ADMIN

PROBE = "http://hostprobe.test"


async def test_goal_mapping_matches_the_agreed_table(client):
    goals = (await client.get("/onboarding")).json()["goals"]
    ids = {g: [p["provider"] for p in ps] for g, ps in goals.items()}
    assert ids == {
        "chat": ["groq", "cerebras"],  # Mistral: the free plan cannot activate API keys
        "writing": ["gemini", "openrouter"],
        "code": ["claude-code", "codex", "grok-build", "opencode", "opencode-zen"],
        "research": ["gemini"],
        "images": ["gemini", "xai"],
        "video": ["xai"],
        "private": ["ollama"],
    }
    paid = {p["provider"] for ps in goals.values() for p in ps if p["paid"]}
    assert paid == {"claude-code", "grok-build", "xai"}


async def test_onboarding_state_roundtrip_and_resume(client):
    first = (await client.get("/onboarding")).json()
    assert first["state"] is None  # first run

    r = await client.put("/onboarding", json={"step": "goals", "name": "  Sam "}, headers=ADMIN)
    assert r.json()["state"]["name"] == "Sam"
    await client.put("/onboarding", json={"goals": ["chat", "code"], "step": "connect"}, headers=ADMIN)
    await client.put("/onboarding", json={"skipped": True}, headers=ADMIN)

    state = (await client.get("/onboarding")).json()["state"]
    assert state["step"] == "connect" and state["goals"] == ["chat", "code"] and state["skipped"] is True
    assert state["name"] == "Sam" and state["completed_at"] is None

    done = await client.put("/onboarding", json={"preset": "balanced", "completed": True}, headers=ADMIN)
    state = done.json()["state"]
    assert state["preset"] == "balanced" and state["skipped"] is False and state["completed_at"]


@pytest.mark.parametrize(
    "body", [{"goals": ["nope"]}, {"step": "bogus"}, {"preset": "cheap"}, {"name": "x" * 61}]
)
async def test_onboarding_rejects_bad_input(client, body):
    r = await client.put("/onboarding", json=body, headers=ADMIN)
    assert r.status_code in (400, 422)


async def test_onboarding_write_needs_admin(client):
    assert (await client.put("/onboarding", json={"name": "x"})).status_code == 401


def test_num_retries_is_passed_per_deployment():
    reg = load_registry()
    d = AliasDeployment("a", "gemini", "m", num_retries=0)
    params, _ = deployment_spec(d, reg)
    assert params["num_retries"] == 0
    params, _ = deployment_spec(AliasDeployment("a", "gemini", "m"), reg)
    assert "num_retries" not in params


def test_smart_free_does_not_retry_before_falling_back_to_local():
    smart = [d for d in load_registry().aliases if d.alias == "smart-free"]
    assert smart and all(d.num_retries == 0 and d.timeout == 30 for d in smart)


async def test_install_plan_run_and_cancel_are_proxied(client, mock_http, hostprobe_up):
    plan = {"plan_id": "p" * 24, "commands": ["download x", "bash install.sh"], "sudo": False}
    route = mock_http.post(f"{PROBE}/install/opencode/plan").respond(200, json=plan)
    started = {"id": "job1", "state": "running"}
    run = mock_http.post(f"{PROBE}/install/opencode/run").respond(202, json=started)
    cancel = mock_http.post(f"{PROBE}/install/jobs/job1/cancel").respond(200, json={"state": "cancelled"})

    r = await client.post("/connections/cli/opencode/install-plan", headers=ADMIN)
    assert r.status_code == 200 and r.json() == plan
    assert route.calls.last.request.headers["x-probe-token"] == "probe-token-test-0123456789"

    body = {"plan_id": plan["plan_id"]}
    r = await client.post("/connections/cli/opencode/install", json=body, headers=ADMIN)
    assert r.status_code == 200 and r.json()["id"] == "job1"
    assert json.loads(run.calls.last.request.content) == {"plan_id": plan["plan_id"]}

    r = await client.post("/connections/cli/jobs/job1/cancel", headers=ADMIN)
    assert r.json()["state"] == "cancelled" and cancel.called


async def test_install_errors_pass_through_and_need_admin(client, mock_http, hostprobe_up):
    mock_http.post(f"{PROBE}/install/opencode/run").respond(409, json={"error": "another install is running"})
    r = await client.post("/connections/cli/opencode/install", json={"plan_id": "x" * 12}, headers=ADMIN)
    assert (r.status_code, r.json()["detail"]) == (409, "another install is running")
    assert (await client.post("/connections/cli/opencode/install-plan")).status_code == 401
    assert (await client.get("/connections/cli/jobs/job1/events")).status_code == 401
    # Only CLI providers can be installed; the provider id never reaches the hostprobe path.
    assert (await client.post("/connections/cli/groq/install-plan", headers=ADMIN)).status_code == 400
    assert (await client.post("/connections/cli/nope/install-plan", headers=ADMIN)).status_code == 404


async def test_install_when_hostprobe_down(client, hostprobe_down):
    r = await client.post("/connections/cli/opencode/install-plan", headers=ADMIN)
    assert r.status_code == 503 and "unreachable" in r.json()["detail"]


async def test_install_events_stream(client, mock_http):
    body = b'id: 1\nevent: log\ndata: "hi"\n\nevent: exit\ndata: {"state": "ok", "exit_code": 0}\n\n'
    mock_http.get(f"{PROBE}/install/jobs/job1/events", params={"from": "0"}).respond(
        200, content=body, headers={"content-type": "text/event-stream"}
    )
    r = await client.get("/connections/cli/jobs/job1/events", headers=ADMIN)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.content == body
    mock_http.get(f"{PROBE}/install/jobs/gone/events", params={"from": "0"}).respond(404, json={"error": "x"})
    assert (await client.get("/connections/cli/jobs/gone/events", headers=ADMIN)).status_code == 404


async def test_cli_refresh_forces_a_fresh_probe(client, mock_http):
    route = mock_http.get(f"{PROBE}/cli", params={"fresh": "1"}).respond(200, json={"clis": {}})
    r = await client.post("/connections/cli/refresh", headers=ADMIN)
    assert r.status_code == 200 and route.called


async def test_xai_is_a_paid_api_key_provider(client, hostprobe_up):
    rows = {p["provider"]: p for p in (await client.get("/connections")).json()["providers"]}
    assert rows["xai"]["kind"] == "api_key" and rows["xai"]["paid"] is True
    assert rows["groq"]["paid"] is False and rows["claude-code"]["paid"] is True
