"""Paperclip adapter contract (M4a, ADR 0007, docs/m4a.md).

Two layers:
- Recorded: every fixture in tests/fixtures/paperclip/ is a real request/response pair from Paperclip
  2026.1106.0 (trimmed to the fields Switchboard reads, home paths anonymised). The adapter is driven
  against them, and each fixture is checked for the fields the router relies on, so an upgrade that changes
  them fails here first.
- Live (`pytest -m live`, needs a running Paperclip at PAPERCLIP_LIVE_URL, default http://127.0.0.1:3100):
  the running version matches the pin, and every route the adapter calls exists in its OpenAPI document.
  Read-only.
"""

import hashlib
import json
import os
from pathlib import Path

import httpx
import pytest

from app import paperclip
from app.paperclip import Paperclip, PaperclipError

FIX = Path(__file__).parent / "fixtures" / "paperclip"
API = "http://paperclip.test/api"


def fx(name: str) -> dict:
    return json.loads((FIX / f"{name}.json").read_text())


# What the router reads from each recorded response (the contract).
REQUIRED = {
    "health": ["status", "version", "deploymentMode", "deploymentExposure"],
    "company_create": ["id", "name"],
    "agent_create_claude": ["id", "status", "lifecycleState", "adapterType", "adapterConfig"],
    "adapter_test_claude_ok": ["status", "checks"],
    "agent_wakeup": ["id", "status", "scopeKind"],
    "run_get_claude_plan": [
        "id",
        "status",
        "error",
        "errorCode",
        "resultJson",
        "usageJson",
        "startedAt",
        "finishedAt",
    ],
    "run_get_claude_edit": ["status", "resultJson", "usageJson"],
    "run_get_codex-proc": ["status", "resultJson"],
    "run_get_opencode-proc": ["status", "resultJson"],
    "run_get_cancelled": ["status", "error"],
    "run_log_live": ["content", "nextOffset"],
    "issue_create": ["id", "identifier", "status", "assigneeAgentId", "createdByUserId"],
    "issue_create_again": ["id"],
    "issue_patch_in_review": ["status"],
    "issue_comment": ["id"],
    "approval_create": ["id", "status"],
    "approval_approve": ["status"],
    "approval_reject": ["status"],
    "instructions_get": ["contentHash", "revision"],
}

# Every route the adapter calls: (method, OpenAPI path).
ROUTES = [
    ("get", "/api/health"),
    ("get", "/api/companies"),
    ("post", "/api/companies"),
    ("get", "/api/companies/{companyId}/agents"),
    ("post", "/api/companies/{companyId}/agents"),
    ("get", "/api/agents/{id}"),
    ("patch", "/api/agents/{id}"),
    ("get", "/api/agents/{id}/instructions-bundle/file"),
    ("put", "/api/agents/{id}/instructions-bundle/file"),
    ("post", "/api/companies/{companyId}/adapters/{type}/test-environment"),
    ("post", "/api/agents/{id}/lifecycle/retry"),
    ("post", "/api/agents/{id}/clear-error"),
    ("post", "/api/agents/{id}/wakeup"),
    # M4b fleet: pause / resume / terminate follow your changes (ADR 0009)
    ("post", "/api/agents/{id}/pause"),
    ("post", "/api/agents/{id}/resume"),
    ("post", "/api/agents/{id}/terminate"),
    ("get", "/api/heartbeat-runs/{runId}"),
    ("get", "/api/companies/{companyId}/heartbeat-runs"),
    ("get", "/api/heartbeat-runs/{runId}/log"),
    ("post", "/api/heartbeat-runs/{runId}/cancel"),
    ("post", "/api/companies/{companyId}/issues"),
    ("patch", "/api/issues/{id}"),
    ("post", "/api/issues/{id}/comments"),
    ("post", "/api/companies/{companyId}/approvals"),
    ("get", "/api/approvals/{id}"),
    ("post", "/api/approvals/{id}/approve"),
    ("post", "/api/approvals/{id}/reject"),
]


@pytest.mark.parametrize("name", sorted(REQUIRED))
def test_recorded_responses_carry_what_the_router_reads(name):
    rec = fx(name)
    assert rec["status"] < 300, name
    missing = [k for k in REQUIRED[name] if k not in rec["response"]]
    assert not missing, f"{name}: Paperclip no longer returns {missing}"


def test_recorded_semantics_the_design_depends_on():
    """The facts ADR 0007 rests on, as recorded."""
    assert fx("health")["response"]["version"] == paperclip.PINNED_VERSION
    assert fx("agent_wakeup")["response"]["scopeKind"] == "company"  # agent-level wake: no issue automations
    assert (
        fx("issue_create_again")["response"]["id"] == fx("issue_create")["response"]["id"]
    )  # idempotency key
    assert fx("issue_create")["response"]["assigneeAgentId"] is None
    bad = fx("issue_patch_in_progress")
    assert bad["status"] == 422 and "assignee" in bad["response"]["error"]  # in_progress needs an owner
    assert fx("agent_create_claude")["response"]["status"] == "paused"  # until its check passes
    usage = fx("run_get_claude_plan")["response"]["usageJson"]
    assert usage["billingType"] == "subscription_included" and usage["costUsd"] > 0
    assert fx("run_get_404")["status"] == 404 and fx("run_cancel_404")["status"] == 404


@pytest.fixture
async def pc(mock_http):
    c = Paperclip()
    yield c
    await c.aclose()


async def test_wake_sends_an_agent_level_on_demand_wake(pc, mock_http):
    route = mock_http.post(f"{API}/agents/ag1/wakeup").respond(202, json=fx("agent_wakeup")["response"])
    run = await pc.wake("ag1", reason="switchboard_job", idempotency_key="sb-job-7-plan")
    body = json.loads(route.calls[0].request.content)
    assert body == {
        "source": "on_demand",
        "triggerDetail": "manual",
        "reason": "switchboard_job",
        "forceFreshSession": True,
        "idempotencyKey": "sb-job-7-plan",
    }
    assert "issueId" not in body and run["status"] == "queued"


async def test_run_log_returns_whole_lines_and_a_byte_offset(pc, mock_http):
    lines = [json.dumps({"ts": "t", "stream": "stdout", "chunk": f"héllo {i}\n"}) for i in range(3)]
    content = "\n".join(lines) + "\n" + lines[0][:10]  # the page ends mid-line
    mock_http.get(f"{API}/heartbeat-runs/r1/log").respond(200, json={"content": content, "nextOffset": 999})
    page = await pc.run_log("r1", offset=100)
    assert [x["chunk"] for x in page.lines] == ["héllo 0\n", "héllo 1\n", "héllo 2\n"]
    whole = ("\n".join(lines) + "\n").encode()
    assert page.next_offset == 100 + len(whole)  # bytes, not characters; the cut line is read again next time


async def test_recorded_log_page_parses(pc, mock_http):
    rec = fx("run_log_live")["response"]
    mock_http.get(f"{API}/heartbeat-runs/r1/log").respond(200, json=rec)
    page = await pc.run_log("r1")
    assert page.lines and all({"ts", "stream", "chunk"} <= set(x) for x in page.lines)


async def test_cancel_of_an_unknown_run_is_success(pc, mock_http):
    mock_http.post(f"{API}/heartbeat-runs/gone/cancel").respond(404, json=fx("run_cancel_404")["response"])
    await pc.cancel_run("gone")
    mock_http.get(f"{API}/heartbeat-runs/gone").respond(404, json=fx("run_get_404")["response"])
    assert await pc.run("gone") is None


async def test_refusals_are_plain_errors_and_are_not_retried(pc, mock_http):
    route = mock_http.patch(f"{API}/issues/i1").respond(422, json=fx("issue_patch_in_progress")["response"])
    with pytest.raises(PaperclipError) as e:
        await pc.set_issue_status("i1", "in_progress")
    assert e.value.status == 422 and "require an assignee" in str(e.value) and route.call_count == 1


async def test_transient_failures_are_retried_then_reported(pc, mock_http, monkeypatch):
    monkeypatch.setattr(paperclip, "RETRY_DELAYS_S", (0, 0))
    route = mock_http.get(f"{API}/heartbeat-runs/r1")
    route.side_effect = [httpx.Response(503), httpx.Response(200, json={"id": "r1", "status": "running"})]
    assert (await pc.run("r1"))["status"] == "running" and route.call_count == 2
    mock_http.get(f"{API}/companies").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(PaperclipError) as e:
        await pc.companies()
    assert e.value.status == 0 and "not reachable" in str(e.value)


async def test_health_never_raises(pc, mock_http):
    mock_http.get(f"{API}/health").mock(side_effect=httpx.ConnectError("refused"))
    assert await pc.health() is None


async def test_issue_and_approval_calls(pc, mock_http):
    create = mock_http.post(f"{API}/companies/c1/issues").respond(201, json=fx("issue_create")["response"])
    issue = await pc.create_issue(
        "c1",
        title="Switchboard job 1",
        description="d",
        assignee_user_id="local-board",
        idempotency_key="sb-job-1",
    )
    body = json.loads(create.calls[0].request.content)
    assert body["assigneeUserId"] == "local-board" and body["idempotencyKey"] == "sb-job-1"
    assert "assigneeAgentId" not in body and issue["identifier"]
    ap = mock_http.post(f"{API}/companies/c1/approvals").respond(201, json=fx("approval_create")["response"])
    await pc.create_approval("c1", issue_id="i1", payload={"kind": "plan"})
    assert json.loads(ap.calls[0].request.content)["type"] == "request_board_approval"
    mock_http.post(url__regex=rf"{API}/approvals/[^/]+/approve").respond(
        200, json=fx("approval_approve")["response"]
    )
    assert (await pc.decide("a1", True, "ok"))["status"] == "approved"


async def test_loopback_host_header_only_for_the_docker_host_name():
    assert paperclip.loopback_host_header("http://host.docker.internal:3100") == "127.0.0.1:3100"
    assert paperclip.loopback_host_header("http://127.0.0.1:3100") is None
    assert paperclip.loopback_host_header("http://paperclip.test") is None


async def test_instructions_are_written_against_the_revision_read(pc, mock_http):
    rec = fx("instructions_get")["response"]
    mock_http.get(f"{API}/agents/a1/instructions-bundle/file").respond(200, json=rec)
    put = mock_http.put(f"{API}/agents/a1/instructions-bundle/file").respond(200, json={})
    await pc.set_instructions("a1", "new task")
    assert json.loads(put.calls[0].request.content)["baseRevisionId"] == rec["revision"]["id"]
    same = {**rec, "contentHash": hashlib.sha256(b"new task").hexdigest()}
    mock_http.get(f"{API}/agents/a1/instructions-bundle/file").respond(200, json=same)
    await pc.set_instructions("a1", "new task")
    assert put.call_count == 1  # unchanged content is not rewritten


async def test_bearer_key_only_when_configured(mock_http, monkeypatch):
    from app.config import get_settings

    route = mock_http.get(f"{API}/companies").respond(200, json=[])
    monkeypatch.setenv("PAPERCLIP_API_KEY", "")  # what compose passes when the key is unset
    get_settings.cache_clear()
    c = Paperclip()
    await c.companies()
    assert "authorization" not in route.calls[0].request.headers
    await c.aclose()
    monkeypatch.setenv("PAPERCLIP_API_KEY", "pcp_board_test")  # gitleaks:allow
    get_settings.cache_clear()
    try:
        c = Paperclip()
        await c.companies()
        assert route.calls[1].request.headers["authorization"] == "Bearer pcp_board_test"  # gitleaks:allow
        await c.aclose()
    finally:
        monkeypatch.delenv("PAPERCLIP_API_KEY")
        get_settings.cache_clear()


# --- live -------------------------------------------------------------------------------------------
LIVE = os.environ.get("PAPERCLIP_LIVE_URL", "http://127.0.0.1:3100")
LIVE_HEADERS = {"Host": h} if (h := paperclip.loopback_host_header(LIVE)) else {}


@pytest.mark.live
def test_live_version_matches_the_pin():
    h = httpx.get(f"{LIVE}/api/health", headers=LIVE_HEADERS, timeout=5).json()
    assert h["version"] == paperclip.PINNED_VERSION, "Paperclip was upgraded: re-verify docs/m4a.md first"
    missing = [k for k in REQUIRED["health"] if k not in h]
    assert not missing


@pytest.mark.live
def test_live_every_route_the_adapter_calls_exists():
    spec = httpx.get(f"{LIVE}/api/openapi.json", headers=LIVE_HEADERS, timeout=30).json()
    paths = spec["paths"]
    missing = [f"{m.upper()} {p}" for m, p in ROUTES if m not in paths.get(p, {})]
    assert not missing, f"routes gone from Paperclip: {missing}"
