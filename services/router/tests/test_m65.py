"""M6.5 subscription windows (ADRs 0013-0015): accounts, usage windows, waiting for resets, paid overflow.

Built on the M4a fakes (tests/test_jobs.py): a stateful fake Paperclip and hostprobe, plus the new hostprobe
routes (accounts, Codex usage numbers, overflow key file) and LiteLLM's key endpoints.
"""

import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from app import accounts, jobs, overflow, subscriptions
from app.agents import AgentsConfigError, build_run, load_agents, parse
from app.metrics import ingest_litellm
from app.models import Cost, Job, JobEvent, UsageWindow
from app.registry import load_registry
from tests.conftest import ADMIN
from tests.test_jobs import HP, FakeHost, FakePaperclip, add_project, get, step

FIX = Path(__file__).parent / "fixtures" / "m65"
LITELLM = "http://litellm.test"


def fixture(name: str) -> dict:
    return json.loads((FIX / f"{name}.json").read_text())


def claude_event(kind: str = "allowed", five_hour: float | None = None, resets_in_h: float = 2.0) -> dict:
    ev = copy.deepcopy(fixture("claude_rate_limit_event")[kind])
    at = int((datetime.now(UTC) + timedelta(hours=resets_in_h)).timestamp())
    info = ev["rate_limit_info"]
    info["resetsAt"] = at
    info["unifiedWindows"]["five_hour"]["resetsAt"] = at
    info["unifiedWindows"]["seven_day"]["resetsAt"] = at + 5 * 86400
    if five_hour is not None:
        info["unifiedWindows"]["five_hour"]["utilization"] = five_hour
    return ev


def line(ev: dict) -> str:
    return json.dumps(ev) + "\n"


# The M6.5 hostprobe routes live in the shared FakeHost (tests/test_jobs.py).
FakeHost65 = FakeHost


class FakeKeys:
    """LiteLLM's /key endpoints (shapes verified on v1.108.8, docs/m65.md)."""

    def __init__(self):
        self.keys: dict[str, dict] = {}
        self.generated: list[dict] = []
        self.n = 0

    def install(self, m):
        m.post(f"{LITELLM}/key/generate").mock(side_effect=self._generate)
        m.get(f"{LITELLM}/key/list").mock(side_effect=self._list)
        m.post(f"{LITELLM}/key/delete").mock(side_effect=self._delete)

    def _generate(self, r):
        b = json.loads(r.content)
        self.n += 1
        key, token = f"sk-overflowtest{self.n:06d}", f"hash{self.n}"
        self.keys[token] = {**b, "token": token, "key": key, "spend": 0.0}
        self.generated.append(b)
        return httpx.Response(200, json={"key": key, "token": token, "key_alias": b["key_alias"]})

    def _list(self, r):
        alias = r.url.params.get("key_alias")
        rows = [
            {"token": t, "key_alias": k["key_alias"], "spend": k["spend"], "expires": None}
            for t, k in self.keys.items()
            if alias is None or k["key_alias"] == alias
        ]
        return httpx.Response(200, json={"keys": rows})

    def _delete(self, r):
        tokens = json.loads(r.content)["keys"]
        found = [t for t in tokens if t in self.keys]
        if not found:
            return httpx.Response(404, json={"error": {"message": "{'error': 'No keys found'}"}})
        for t in found:
            del self.keys[t]
        return httpx.Response(200, json={"deleted_keys": found})


@pytest.fixture
def fakes65(mock_http, litellm):
    pc, host, keys = FakePaperclip(), FakeHost65(), FakeKeys()
    pc.install(mock_http)
    host.install(mock_http)
    keys.install(mock_http)
    accounts._status_cache.clear()
    return pc, host, keys


async def new_job(client, pid: int | None = None, **kw) -> dict:
    pid = pid or await add_project(client)
    body = {"prompt": "Add a function multiply(a, b) with tests", "project_id": pid, **kw}
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()


def stdout(pc: FakePaperclip, rid: str, text: str) -> None:
    pc.logs[rid] += json.dumps({"ts": "t", "stream": "stdout", "chunk": text}) + "\n"


# --- registry ----------------------------------------------------------------------
def test_registry_has_subscription_clis_guard_and_overflow():
    reg = load_agents()
    assert set(reg.clis) == {"claude", "codex"}
    claude = reg.clis["claude"]
    assert claude.home_env == "CLAUDE_CONFIG_DIR" and claude.usage == "stream_event"
    assert [w.id for w in claude.windows] == ["five_hour", "seven_day"]
    assert reg.clis["codex"].usage == "session_file" and reg.clis["codex"].home_env == "CODEX_HOME"
    assert reg.subscription(reg.agents["claude-code"]) is claude
    assert reg.subscription(reg.agents["opencode"]) is None  # OpenCode Zen is no subscription
    g = reg.defaults.guard
    assert (g.save_at, g.block_at, reg.defaults.max_auto_wait_h, reg.defaults.max_waits) == (0.8, 1.0, 12, 3)


@pytest.mark.parametrize(
    "patch, msg",
    [
        ({"clis": {"x": {"home_env": "lower", "windows": {"w": {"hours": 1}}}}}, "home_env"),
        ({"clis": {"x": {"home_env": "X_HOME", "windows": {}}}}, "at least one window"),
        ({"clis": {"x": {"home_env": "X_HOME", "usage": "screen", "windows": {"w": {"hours": 1}}}}}, "usage"),
        ({"defaults": {"subscription_guard": {"save_at": 0.9, "block_at": 0.5}}}, "save_at"),
        ({"defaults": {"max_waits": 0}}, "max_waits"),
    ],
)
def test_bad_subscription_config_is_refused(patch, msg):
    import yaml

    data = yaml.safe_load(
        (Path(load_agents.__globals__["get_settings"]().config_dir) / "agents.yaml").read_text()
    )
    for k, v in patch.items():
        data[k] = {**(data.get(k) or {}), **v} if k == "defaults" else v
    with pytest.raises(AgentsConfigError, match=msg):
        parse(data)


# --- readings ----------------------------------------------------------------------
def test_claude_rate_limit_event_from_a_real_run():
    ev = fixture("claude_rate_limit_event")["allowed"]
    got = {r.window: r for r in subscriptions.parse_claude(ev)}
    assert got["five_hour"].used == 0.56 and got["seven_day"].used == 0.07
    assert not got["five_hour"].limited and got["five_hour"].resets_at.timestamp() == 1795172400
    rej = {r.window: r for r in subscriptions.parse_claude(fixture("claude_rate_limit_event")["rejected"])}
    assert rej["five_hour"].limited and rej["five_hour"].used == 1.0 and not rej["seven_day"].limited
    assert subscriptions.parse_claude({"type": "assistant"}) == []


def test_codex_numbers_from_hostprobe():
    got = subscriptions.parse_codex(fixture("codex_usage")["free_plan"])
    assert len(got) == 1 and got[0].window == "primary" and got[0].used == 0.0 and got[0].hours == 720
    hit = subscriptions.parse_codex(
        {
            "found": True,
            "primary": {"used_percent": 100, "window_minutes": 300, "resets_at": 1797747531},
            "limit_reached": True,
        }
    )
    assert hit[0].limited and hit[0].hours == 5
    assert subscriptions.parse_codex({"found": False}) == []


# --- accounts ----------------------------------------------------------------------
async def test_accounts_api_creates_lists_and_refuses_removal_in_use(client, fakes65, session):
    _, host, _ = fakes65
    r = await client.post(
        "/accounts", json={"cli": "claude", "name": "work", "label": "Company seat"}, headers=ADMIN
    )
    assert r.status_code == 201 and r.json()["login_command"].startswith("CLAUDE_CONFIG_DIR=")
    assert ("claude", "work") in host.accounts
    r = await client.post("/accounts", json={"cli": "claude", "name": "../x"}, headers=ADMIN)
    assert r.status_code == 400
    r = await client.post("/accounts", json={"cli": "opencode", "name": "x"}, headers=ADMIN)
    assert r.status_code == 400
    listing = (await client.get("/accounts", headers=ADMIN)).json()["clis"]
    claude = next(c for c in listing if c["cli"] == "claude")
    assert [a["name"] for a in claude["accounts"]] == ["default", "work"]
    assert (
        claude["accounts"][1]["plan_label"] == "Claude Team"
        and claude["accounts"][0]["plan_label"] == "Claude Pro"
    )
    pid = await add_project(client)
    r = await client.put(f"/projects/{pid}/accounts", json={"accounts": {"claude": "work"}}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["accounts"] == {"claude": "work"}, r.text
    r = await client.put(f"/projects/{pid}/accounts", json={"accounts": {"claude": "nope"}}, headers=ADMIN)
    assert r.status_code == 400, r.text
    r = await client.delete("/accounts/claude/work", headers=ADMIN)
    assert r.status_code == 409 and "project" in r.json()["detail"]
    await client.put(f"/projects/{pid}/accounts", json={"accounts": {}}, headers=ADMIN)
    assert (await client.delete("/accounts/claude/work", headers=ADMIN)).status_code == 200
    assert (await client.delete("/accounts/claude/work", headers=ADMIN)).status_code == 200  # idempotent


def test_run_config_points_the_cli_at_the_account_and_never_carries_a_key():
    reg = load_agents()
    spec = build_run(
        reg,
        reg.agents["claude-code"],
        "edit",
        worktree="/w",
        task="t",
        budget_left_usd=1,
        account_home="/home/u/.switchboard/accounts/claude/work",
    )
    assert spec.adapter_config["env"]["CLAUDE_CONFIG_DIR"] == "/home/u/.switchboard/accounts/claude/work"
    default = build_run(reg, reg.agents["claude-code"], "edit", worktree="/w", task="t", budget_left_usd=1)
    assert "CLAUDE_CONFIG_DIR" not in default.adapter_config["env"]
    paid = build_run(
        reg,
        reg.agents["opencode-paid"],
        "edit",
        worktree="/w",
        task="t",
        budget_left_usd=1,
        overflow={"key_file": "/home/u/.switchboard/overflow/opencode-paid.key", "model": "grok"},
    )
    cfg = json.loads(paid.adapter_config["env"]["OPENCODE_CONFIG_CONTENT"])
    prov = cfg["provider"]["switchboard"]
    assert prov["options"]["apiKey"] == "{file:/home/u/.switchboard/overflow/opencode-paid.key}"
    assert prov["options"]["baseURL"].endswith("/v1") and list(prov["models"]) == ["grok"]
    assert "switchboard/grok" in paid.adapter_config["args"]
    assert "sk-" not in json.dumps(paid.adapter_config)
    with pytest.raises(KeyError):
        build_run(reg, reg.agents["opencode-paid"], "edit", worktree="/w", task="t", budget_left_usd=1)


async def test_never_falls_back_to_another_account_of_the_same_cli(client, fakes65, session):
    await client.post("/accounts", json={"cli": "claude", "name": "work"}, headers=ADMIN)
    r = await client.post(
        "/agents",
        json={"template": "claude-code", "label": "Claude (work)", "account": "work"},
        headers=ADMIN,
    )
    assert r.status_code == 201, r.text
    work_agent = r.json()["id"]
    pid = await add_project(client)
    body = {
        "prompt": "Fix the tests",
        "project_id": pid,
        "agents": ["claude-code", work_agent],
        "autonomy": 2,
    }
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 400 and "never switches accounts" in r.json()["detail"]
    r = await client.post("/jobs/preview", json=body, headers=ADMIN)
    assert r.status_code == 200 and not r.json()["ok"] and "never switches" in r.json()["problem"]
    # Another provider as the fallback is fine.
    r = await client.post("/jobs", json={**body, "agents": [work_agent, "codex"]}, headers=ADMIN)
    assert r.status_code == 201 and r.json()["account"] == "work"


async def test_a_job_runs_with_its_accounts_folder(client, fakes65, session):
    pc, _, _ = fakes65
    await client.post("/accounts", json={"cli": "claude", "name": "work"}, headers=ADMIN)
    pid = await add_project(client)
    await client.put(f"/projects/{pid}/accounts", json={"accounts": {"claude": "work"}}, headers=ADMIN)
    job = await new_job(client, pid, agent="claude-code", autonomy=2)
    await step(job["id"])
    cfg = pc.runs[pc.last_run()]["config"]
    assert cfg["env"]["CLAUDE_CONFIG_DIR"] == "/home/user/.switchboard/accounts/claude/work"


async def test_logged_out_account_is_a_plain_reason(client, fakes65, session):
    _, host, _ = fakes65
    await client.post("/accounts", json={"cli": "claude", "name": "work"}, headers=ADMIN)
    host.logged_out.add(("claude", "work"))
    pid = await add_project(client)
    await client.put(f"/projects/{pid}/accounts", json={"accounts": {"claude": "work"}}, headers=ADMIN)
    r = await client.post(
        "/jobs/preview", json={"prompt": "x", "project_id": pid, "agents": ["claude-code"]}, headers=ADMIN
    )
    row = r.json()["agents"][0]
    assert "not logged in" in row["reason"] and "CLAUDE_CONFIG_DIR" in row["reason"]


# --- windows and the guard ----------------------------------------------------------------------
async def test_live_reading_is_stored_and_shown(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    await step(job["id"])
    stdout(pc, pc.last_run(), line(claude_event(five_hour=0.42)))
    await step(job["id"])  # still running: the reading is stored live
    row = await session.get(UsageWindow, ("claude", "default", "five_hour"))
    assert row.source == "reported" and row.used == pytest.approx(0.42) and not row.limited
    w = (await client.get("/subscriptions/windows", headers=ADMIN)).json()["accounts"]
    claude = next(a for a in w if a["cli"] == "claude" and a["account"] == "default")
    assert claude["tightest"]["window"] == "five_hour" and claude["plan_label"] == "Claude Pro"
    agents = (await client.get("/agents", headers=ADMIN)).json()["agents"]
    sub = next(a for a in agents if a["id"] == "claude-code")["subscription"]
    assert sub["tightest"]["used"] == pytest.approx(0.42) and sub["tightest"]["source"] == "reported"


async def _set_window(
    session, used: float, *, limited=False, hours_left=2.0, account="default", cli="claude"
):
    from sqlalchemy.dialects.postgresql import insert

    vals = dict(
        cli=cli,
        account=account,
        window="five_hour" if cli == "claude" else "primary",
        used=used,
        resets_at=datetime.now(UTC) + timedelta(hours=hours_left),
        limited=limited,
        source="reported",
        hours=5,
        seen_at=datetime.now(UTC),
    )
    await session.execute(
        insert(UsageWindow)
        .values(**vals)
        .on_conflict_do_update(
            index_elements=["cli", "account", "window"],
            set_={k: v for k, v in vals.items() if k not in ("cli", "account", "window")},
        )
    )
    await session.commit()


async def test_guard_saves_the_window_for_heavy_work(client, fakes65, session):
    await _set_window(session, 0.85)
    pid = await add_project(client)
    light = {
        "prompt": "Explain the code",
        "project_id": pid,
        "agents": ["claude-code", "codex"],
        "autonomy": 0,
    }
    p = (await client.post("/jobs/preview", json=light, headers=ADMIN)).json()
    assert p["agent"] == "codex" and "saving it for heavy work" in p["agents"][0]["reason"]
    heavy = {**light, "autonomy": 2}
    assert (await client.post("/jobs/preview", json=heavy, headers=ADMIN)).json()["agent"] == "claude-code"
    await _set_window(session, 1.0)
    p = (await client.post("/jobs/preview", json=heavy, headers=ADMIN)).json()
    assert p["agent"] == "codex" and "used its 5-hour window" in p["agents"][0]["reason"]


async def test_estimate_is_labelled_and_never_invents_a_percentage(client, fakes65, session):
    reg = load_agents()
    views = await subscriptions.windows(session, reg, reg.clis["claude"], None)
    five = next(v for v in views if v["window"] == "five_hour")
    assert five["source"] == "estimate" and five["used"] is None and five["runs"] == 0
    # After the window reset, with a learned capacity: our own runs since the reset, as an estimate.
    await _set_window(session, 0.5, hours_left=-1)
    row = await session.get(UsageWindow, ("claude", "default", "five_hour"))
    row.capacity = 2.0
    await session.commit()
    job = await new_job(client, agent="claude-code", autonomy=2)
    session.add(
        Cost(
            source="paperclip",
            kind="job",
            job_id=job["id"],
            list_price_usd=0.5,
            cost_usd=0,
            external_id="paperclip-run:est-1",
            created_at=datetime.now(UTC),
        )
    )
    await session.commit()
    five = next(
        v
        for v in await subscriptions.windows(session, reg, reg.clis["claude"], None)
        if v["window"] == "five_hour"
    )
    assert five["source"] == "estimate" and five["used"] == pytest.approx(0.25) and five["runs"] == 1


# --- waiting and resuming ----------------------------------------------------------------------
async def test_limit_hit_mid_run_waits_and_resumes_the_same_phase(client, fakes65, session):
    pc, host, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    await step(jid)
    first = pc.last_run()
    stdout(pc, first, line(claude_event("rejected", resets_in_h=1.5)))
    pc.finish(first, status="failed")
    await step(jid)
    j = await get(session, jid)
    assert j.status == "waiting_reset" and j.attempt == 1 and j.waits == 1 and not j.worktree_removed
    assert abs((j.resume_at - datetime.now(UTC)).total_seconds() - 5400) < 120
    assert next(iter(pc.issues.values()))["status"] == "blocked"
    assert (await session.get(UsageWindow, ("claude", "default", "five_hour"))).limited
    await step(jid)  # before the reset nothing happens
    assert (await get(session, jid)).status == "waiting_reset"
    # A router restart loses nothing: all of it is in the database.
    jobs._counters.clear()
    jobs._locks.clear()
    j.resume_at = datetime.now(UTC) - timedelta(seconds=1)
    await session.commit()
    await _set_window(session, 0.0)  # the window reset
    await step(jid, 2)
    j = await get(session, jid)
    assert j.status == "running"
    assert pc.wakes[-1]["body"]["idempotencyKey"] == f"switchboard-job-{jid}-run-0-a1"
    assert "cut off by a usage limit" in pc.instructions[j.paperclip_agent_id]  # Claude reads AGENTS.md
    kinds = [e.kind for e in (await session.scalars(select(JobEvent).where(JobEvent.job_id == jid))).all()]
    assert {"limit_hit", "waiting_reset", "resumed"} <= set(kinds)


async def test_limit_hit_from_the_error_text(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    await step(job["id"])
    pc.runs[pc.last_run()]["error"] = "Claude AI usage limit reached|1795172400"
    pc.finish(pc.last_run(), status="failed")
    await step(job["id"])
    j = await get(session, job["id"])
    assert j.status == "waiting_reset"  # reset unknown: the configured 5-hour window, as an estimate
    ev = await session.scalar(
        select(JobEvent).where(JobEvent.job_id == j.id, JobEvent.kind == "waiting_reset")
    )
    assert ev.data["estimated"] is True


async def test_an_ordinary_failure_still_fails(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    await step(job["id"])
    pc.runs[pc.last_run()]["error"] = "The process exited with code 1"
    pc.finish(pc.last_run(), status="failed")
    await step(job["id"])
    assert (await get(session, job["id"])).status == "failed"


async def test_far_reset_asks_you_and_wait_anyway_resumes(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    await step(jid)
    stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=30)))
    pc.finish(pc.last_run(), status="failed")
    await step(jid)
    j = await get(session, jid)
    assert (j.status, j.gate) == ("needs_approval", "limit") and j.resume_at is not None
    assert pc.approvals[j.paperclip_approval_id]["payload"]["kind"] == "limit"
    r = await client.post(f"/jobs/{jid}/wait", headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "waiting_reset"
    assert (await client.post(f"/jobs/{jid}/wait", headers=ADMIN)).status_code == 409


async def test_far_reset_question_expires_like_an_approval(client, fakes65, session):
    pc, _, _ = fakes65
    await client.put("/settings", json={"approval_expiry_h": 1}, headers=ADMIN)
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    await step(jid)
    stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=48)))
    pc.finish(pc.last_run(), status="failed")
    await step(jid)
    ev = await session.scalar(
        select(JobEvent)
        .where(JobEvent.job_id == jid, JobEvent.kind == "needs_approval")
        .order_by(JobEvent.id.desc())
    )
    ev.created_at = datetime.now(UTC) - timedelta(hours=2)
    await session.commit()
    await step(jid)
    j = await get(session, jid)
    assert j.status == "stopped" and "usage limit" in j.error and j.resume_at is None


async def test_too_many_waits_fail_with_a_plain_reason(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    for _ in range(load_agents().defaults.max_waits + 1):
        await step(jid)
        j = await get(session, jid)
        if j.status == "waiting_reset":
            j.resume_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()
            await _set_window(session, 0.0)
            await step(jid, 2)
        stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=1)))
        pc.finish(pc.last_run(), status="failed")
    await step(jid)
    j = await get(session, jid)
    assert j.status == "failed" and "already waited for 3 resets" in j.error


async def test_all_windows_used_before_start_waits_instead_of_failing(client, fakes65, session):
    await _set_window(session, 1.0, limited=True, hours_left=1)
    await _set_window(session, 1.0, limited=True, hours_left=3, cli="codex")
    pid = await add_project(client)
    p = (
        await client.post(
            "/jobs/preview",
            json={"prompt": "x", "project_id": pid, "agents": ["claude-code", "codex"], "autonomy": 2},
            headers=ADMIN,
        )
    ).json()
    assert p["ok"] and p["agent"] is None and p["waits_until"] and "waits" in " ".join(p["steps"])
    job = await new_job(client, pid, agents=["claude-code", "codex"], autonomy=2)
    await step(job["id"])
    j = await get(session, job["id"])
    assert j.status == "waiting_reset" and j.attempt == 0 and j.started_at is None
    assert abs((j.resume_at - datetime.now(UTC)).total_seconds() - 3600) < 120  # the earliest reset


async def test_reroute_moves_a_waiting_job_to_another_provider_only(client, fakes65, session):
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    await step(jid)
    stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=2)))
    pc.finish(pc.last_run(), status="failed")
    await step(jid)
    r = await client.post("/agents", json={"template": "claude-code", "label": "Other Claude"}, headers=ADMIN)
    r = await client.post(f"/jobs/{jid}/reroute", json={"agent": r.json()["id"]}, headers=ADMIN)
    assert r.status_code == 400 and "never switches accounts" in r.json()["detail"]
    r = await client.post(f"/jobs/{jid}/reroute", json={"agent": "codex"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["agent"] == "codex" and r.json()["status"] == "queued"
    await step(jid)
    assert pc.runs[pc.last_run()]["config"]["command"] == "codex"
    assert pc.wakes[-1]["body"]["idempotencyKey"].endswith("-a2")


async def test_limit_injection_is_dev_only_and_once_per_job(client, fakes65, session, monkeypatch):
    from app.config import get_settings

    pc, _, _ = fakes65
    monkeypatch.setattr(get_settings(), "router_limit_test", "claude:resets_in=60")
    job = await new_job(client, agent="claude-code", autonomy=2)
    await step(job["id"])
    pc.finish(pc.last_run(), fixture="run_get_claude_edit")
    await step(job["id"])
    j = await get(session, job["id"])
    assert j.status == "waiting_reset"
    j.resume_at = datetime.now(UTC) - timedelta(seconds=1)
    await session.commit()
    await _set_window(session, 0.0)
    await step(job["id"], 2)
    pc.finish(pc.last_run(), fixture="run_get_claude_edit")
    await step(job["id"])
    assert (await get(session, job["id"])).status == "needs_approval"  # injected once only


# --- Codex ----------------------------------------------------------------------
async def test_codex_window_is_read_by_thread_id(client, fakes65, session):
    pc, host, _ = fakes65
    host.codex = fixture("codex_usage")["free_plan"]
    job = await new_job(client, agent="codex", autonomy=2)
    await step(job["id"])
    thread = "01a1f7c1-5f22-7161-8aae-2ae85c268df3"
    stdout(pc, pc.last_run(), line({"type": "thread.started", "thread_id": thread}))
    pc.finish(
        pc.last_run(),
        stdout=line({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}),
    )
    await step(job["id"])
    assert host.codex_calls == [{"thread_id": thread, "account": "default"}]
    row = await session.get(UsageWindow, ("codex", "default", "primary"))
    assert row.source == "reported" and row.used == 0.0 and row.hours == 720


async def test_codex_limit_from_its_session_file(client, fakes65, session):
    pc, host, _ = fakes65
    at = (datetime.now(UTC) + timedelta(hours=2)).timestamp()
    host.codex = {
        "found": True,
        "primary": {"used_percent": 100.0, "window_minutes": 300, "resets_at": at},
        "limit_reached": True,
    }
    job = await new_job(client, agent="codex", autonomy=2)
    await step(job["id"])
    stdout(
        pc,
        pc.last_run(),
        line({"type": "thread.started", "thread_id": "01a1f7c1-5f22-7161-8aae-2ae85c268df3"}),
    )
    pc.finish(pc.last_run(), status="failed")
    await step(job["id"])
    j = await get(session, job["id"])
    assert j.status == "waiting_reset" and abs(j.resume_at.timestamp() - at) < 2


# --- paid overflow ----------------------------------------------------------------------
async def _enable_overflow(client, monkeypatch, budget=5.0):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "router_overflow_allow_free", True)
    r = await client.put(
        "/settings/overflow", json={"enabled": True, "monthly_usd": budget, "model": "fast"}, headers=ADMIN
    )
    assert r.status_code == 200, r.text
    assert r.json()["ready"] and r.json()["test_free_model"] is True


async def test_overflow_is_off_by_default_and_needs_a_budget_and_paid_model(client, fakes65, session):
    st = (await client.get("/settings/overflow", headers=ADMIN)).json()
    assert st["enabled"] is False and st["ready"] is False
    r = await client.put("/settings/overflow", json={"enabled": True, "model": "fast"}, headers=ADMIN)
    assert r.status_code == 400 and "monthly budget" in r.json()["detail"]
    r = await client.put(
        "/settings/overflow", json={"enabled": True, "monthly_usd": 5, "model": "fast"}, headers=ADMIN
    )
    assert r.status_code == 400  # `fast` is a free model: not offered outside test mode
    pid = await add_project(client)
    r = await client.post(
        "/jobs", json={"prompt": "x", "project_id": pid, "paid_budget_usd": 1}, headers=ADMIN
    )
    assert r.status_code == 409 and "off" in r.json()["detail"]


async def test_paid_job_key_lifecycle_never_touches_paperclip_config(client, fakes65, session, monkeypatch):
    pc, host, keys = fakes65
    await _enable_overflow(client, monkeypatch)
    pid = await add_project(client)
    p = (
        await client.post(
            "/jobs/preview",
            json={"prompt": "x", "project_id": pid, "paid_budget_usd": 1, "autonomy": 2},
            headers=ADMIN,
        )
    ).json()
    assert p["ok"] and p["paid"] and p["steps"][0].startswith("Paid:") and p["agent"] == "opencode-paid"
    job = await new_job(client, pid, paid_budget_usd=1.0, autonomy=2)
    jid = job["id"]
    assert job["paid"] and job["agent"] == "opencode-paid"
    await step(jid)
    gen = keys.generated[-1]
    assert (
        gen["models"] == ["fast"]
        and gen["max_budget"] == 1.0
        and gen["key_alias"] == f"sb-overflow-job-{jid}-r0-a0"
    )
    assert set(gen["metadata"]["tags"]) == {"switchboard-overflow", f"sb-job-{jid}"}
    key = host.key_files["opencode-paid"]
    cfg = pc.runs[pc.last_run()]["config"]
    assert key not in json.dumps(cfg) and key not in json.dumps(pc.agents)  # never in Paperclip
    assert (
        "{file:/home/user/.switchboard/overflow/opencode-paid.key}" in cfg["env"]["OPENCODE_CONFIG_CONTENT"]
    )
    next(iter(keys.keys.values()))["spend"] = 0.12
    pc.finish(
        pc.last_run(),
        stdout=line({"type": "step_finish", "part": {"tokens": {"input": 5, "output": 2}, "cost": 0}}),
    )
    await step(jid)
    j = await get(session, jid)
    assert not keys.keys and "opencode-paid" not in host.key_files  # revoked and removed
    assert float(j.cost_usd) == pytest.approx(0.12) and j.status == "needs_approval"
    n = await session.scalar(select(func.count()).select_from(Cost).where(Cost.job_id == jid))
    assert n == 0  # the cost comes from LiteLLM's spend log, never twice


async def test_paid_key_is_revoked_on_stop_and_by_the_sweep(client, fakes65, session, monkeypatch):
    pc, host, keys = fakes65
    await _enable_overflow(client, monkeypatch)
    job = await new_job(client, paid_budget_usd=1.0, autonomy=2)
    await step(job["id"])
    assert keys.keys and host.key_files
    r = await client.post(f"/jobs/{job['id']}/stop", headers=ADMIN)
    assert r.json()["status"] == "stopped" and not keys.keys and not host.key_files
    # Crash recovery: a key and a file nobody owns are removed; a running paid job's key is kept.
    keys.keys["orphan"] = {"key_alias": "sb-overflow-job-999-r0-a0", "spend": 0.0, "token": "orphan"}
    keys.keys["other"] = {"key_alias": "someone-else", "spend": 0.0, "token": "other"}
    host.key_files["opencode-paid"] = "sk-left-behind"
    assert await jobs.sweep_overflow(session) == 2
    assert list(keys.keys) == ["other"] and not host.key_files
    # Nothing paid in Paperclip's stored agent configs, whatever happened.
    assert "sk-overflowtest" not in json.dumps(pc.agents)


async def test_use_paid_for_a_waiting_job_and_its_budget_check(client, fakes65, session, monkeypatch):
    pc, _, keys = fakes65
    await _enable_overflow(client, monkeypatch, budget=2.0)
    job = await new_job(client, agent="claude-code", autonomy=2)
    jid = job["id"]
    await step(jid)
    stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=2)))
    pc.finish(pc.last_run(), status="failed")
    await step(jid)
    r = await client.post(f"/jobs/{jid}/paid", json={"budget_usd": 5}, headers=ADMIN)
    assert r.status_code == 409 and "budget left" in r.json()["detail"]
    r = await client.post(f"/jobs/{jid}/paid", json={"budget_usd": 1.5}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["paid"] and r.json()["agent"] == "opencode-paid"
    await step(jid)
    assert keys.generated[-1]["key_alias"] == f"sb-overflow-job-{jid}-r0-a2"


def test_spend_ingest_files_overflow_calls_under_their_job():
    from app.litellm_spend import SpendLog

    lg = SpendLog(
        call_id="abc",
        status="success",
        spend=0.2,
        tokens_in=10,
        tokens_out=5,
        model="xai/grok-4",
        provider="xai",
        model_group="grok",
        end_user="",
        tags=("switchboard-overflow", "sb-job-42"),
        started=datetime.now(UTC),
    )
    row = ingest_litellm.row_for(load_registry(), lg)
    assert row["kind"] == "job" and row["job_id"] == 42 and row["list_price_usd"] == 0.2
    other = ingest_litellm.row_for(load_registry(), SpendLog(**{**lg.__dict__, "tags": ("sb-job-42",)}))
    assert other["kind"] == "external" and "job_id" not in other


async def test_overflow_check_refuses_tiny_and_large_budgets(client, fakes65, session, monkeypatch):
    await _enable_overflow(client, monkeypatch, budget=1.0)
    with pytest.raises(overflow.OverflowError, match="at least"):
        await overflow.check(session, 0.01)
    with pytest.raises(overflow.OverflowError, match="budget left"):
        await overflow.check(session, 2.0)
    await overflow.check(session, 1.0)
    assert Job  # noqa: B018 - imported for get()


# --- M6 carry-overs and reporting ------------------------------------------------------------------------
async def test_rollup_health_ok_behind_stopped_and_catch_up(client, fakes65, session, mock_http):
    mock_http.get(url__regex=rf"{HP}/net/listen").respond(
        200, json={"port": 3100, "addresses": ["127.0.0.1"], "loopback_only": True}
    )
    from app.metrics import rollup
    from app.models import MetricsDirty

    assert (await rollup.health(session))["state"] == "ok"  # fresh install: nothing ran, nothing waits
    t0 = datetime.now(UTC)
    await rollup._save_health(session, last_run_at=t0.isoformat(), last_ok_at=t0.isoformat())
    session.add(
        MetricsDirty(
            bucket_start=t0.replace(minute=0, second=0, microsecond=0), marked_at=t0 - timedelta(minutes=20)
        )
    )
    await session.commit()
    h = await rollup.health(session)
    assert h["state"] == "behind" and h["pending_buckets"] == 1
    assert (await rollup.health(session, now=t0 + timedelta(minutes=10)))["state"] == "stopped"
    comps = (await client.get("/system/components", headers=ADMIN)).json()["components"]
    row = next(c for c in comps if c["id"] == "rollups")
    assert row["status"] == "degraded" and row["fix"] == "rebuild_rollups" and row["pending_buckets"] == 1
    r = await client.post("/system/rollups/run", headers=ADMIN)
    assert r.status_code == 200 and r.json()["pending_buckets"] == 0 and r.json()["state"] == "ok"


async def test_health_reports_dev_switches_and_rollups(client, fakes65, monkeypatch):
    from app.config import get_settings

    h = (await client.get("/health")).json()
    assert h["limit_test"] is None and h["overflow_allow_free"] is False and h["rollups"]["state"] == "ok"
    monkeypatch.setattr(get_settings(), "router_limit_test", "claude:resets_in=60")
    assert (await client.get("/health")).json()["limit_test"] == "claude:resets_in=60"


async def test_status_and_metrics_show_subscription_windows(client, fakes65, session, mock_http):
    mock_http.get(url__regex=rf"{HP}/net/listen").respond(
        200, json={"port": 3100, "addresses": ["127.0.0.1"], "loopback_only": True}
    )
    pc, _, _ = fakes65
    job = await new_job(client, agent="claude-code", autonomy=2)
    await step(job["id"])
    stdout(pc, pc.last_run(), line(claude_event("rejected", resets_in_h=1)))
    pc.finish(pc.last_run(), status="failed")
    await step(job["id"])
    comps = (await client.get("/system/components", headers=ADMIN)).json()["components"]
    row = next(c for c in comps if c["id"] == "subscription:claude:default")
    assert row["status"] == "down" and row["name"] == "Claude Pro" and row["until"]
    q = (await client.get("/metrics/quotas", headers=ADMIN)).json()
    sub = next(s for s in q["subscriptions"] if s["cli"] == "claude" and s["account"] == "default")
    assert sub["limit_hits_30d"] == 1 and sub["tightest"]["limited"] and "providers" in q
