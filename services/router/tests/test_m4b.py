"""M4b backend: board filters and counts, preview == what the job loop does, Run as job proposals, run logs,
the fleet overlay (hire, edit, pause, reset, soft delete, Paperclip sync), approval expiry, retention setting,
project worktrees and the Paperclip notes on Status. Same fakes as test_jobs (recorded Paperclip shapes)."""

from datetime import timedelta

from sqlalchemy import select, update

from app import jobs
from app.api import system
from app.models import Cost, JobEvent
from app.models import Request as RequestRow
from tests.conftest import ADMIN
from tests.test_jobs import HP, add_project, fakes, get, start, step  # noqa: F401 (fixture)


async def job(client, pid: int, **kw) -> dict:
    body = {"prompt": "Add a function multiply(a, b) with tests", "project_id": pid, **kw}
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()


# --- board ---------------------------------------------------------------------------------------------
async def test_board_filters_counts_and_paging(client, fakes, session):
    pid = await add_project(client)
    a = await job(client, pid, agent="claude-code", autonomy=1)
    b = await job(client, pid, agent="codex", autonomy=0)
    c = await job(client, pid, agent="codex", autonomy=0)
    await client.post(f"/jobs/{c['id']}/stop", headers=ADMIN)

    r = (await client.get("/jobs?agent=codex", headers=ADMIN)).json()
    assert [j["id"] for j in r["jobs"]] == [c["id"], b["id"]]
    assert r["jobs"][0]["project"]["name"] == "playground" and r["jobs"][0]["agent_label"] == "Codex"
    r = (await client.get(f"/jobs?project_id={pid}&status=queued", headers=ADMIN)).json()
    assert [j["id"] for j in r["jobs"]] == [b["id"], a["id"]]
    page1 = (await client.get("/jobs?limit=2", headers=ADMIN)).json()
    assert len(page1["jobs"]) == 2 and page1["next"] == b["id"]
    page2 = (await client.get(f"/jobs?limit=2&before={page1['next']}", headers=ADMIN)).json()
    assert [j["id"] for j in page2["jobs"]] == [a["id"]] and page2["next"] is None

    counts = (await client.get("/jobs/counts", headers=ADMIN)).json()
    assert counts["counts"]["queued"] == 2 and counts["counts"]["stopped"] == 1
    assert counts["all"] == 3 and counts["needs_you"] == 0
    assert (await client.get("/jobs/counts?agent=claude-code", headers=ADMIN)).json()["all"] == 1
    assert (await client.get("/jobs?status=bogus", headers=ADMIN)).status_code == 422


# --- preview -------------------------------------------------------------------------------------------
async def test_preview_says_what_will_happen_and_matches_the_start(client, fakes, session):
    pc, host = fakes
    host.installed = {"codex", "opencode"}  # claude-code isn't installed: the preview skips it with why
    pid = await add_project(client)
    body = {
        "prompt": "Add a function multiply(a, b) with tests",
        "project_id": pid,
        "agents": ["claude-code", "opencode", "codex"],
        "autonomy": 1,
        "budget_list_usd": 0.5,
    }
    r = await client.post("/jobs/preview", json=body, headers=ADMIN)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["ok"] and p["agent"] == "opencode" and p["budget_list_usd"] == 0.5
    assert [(x["id"], bool(x["reason"]), x["chosen"]) for x in p["agents"]] == [
        ("claude-code", True, False),
        ("opencode", False, True),
        ("codex", False, False),
    ]
    text = " ".join(p["steps"])
    assert "Nothing more happens until you approve the plan" in text
    assert "switchboard/job-<number>" in text and "Nothing is pushed" in text
    assert "$0.50 list price" in text and "If OpenCode can't start, Codex takes the job" in text
    assert (await client.get("/jobs", headers=ADMIN)).json()["jobs"] == []  # nothing was created

    created = (await client.post("/jobs", json=body, headers=ADMIN)).json()
    assert created["agent_chain"] == ["claude-code", "opencode", "codex"]
    await step(created["id"])
    assert (await get(session, created["id"])).agent == p["agent"]  # the loop chose what the preview said

    level0 = (await client.post("/jobs/preview", json={**body, "autonomy": 0}, headers=ADMIN)).json()
    assert "writes a report" in " ".join(level0["steps"]) and "approve the plan" not in " ".join(
        level0["steps"]
    )
    codex = (
        await client.post("/jobs/preview", json={**body, "agents": ["codex"], "autonomy": 2}, headers=ADMIN)
    ).json()
    assert "doesn't report its cost" in " ".join(codex["steps"])
    none = (
        await client.post("/jobs/preview", json={**body, "agents": ["claude-code"]}, headers=ADMIN)
    ).json()
    assert not none["ok"] and "not installed" in none["problem"] and none["steps"] == []
    three = (await client.post("/jobs/preview", json={**body, "autonomy": 3}, headers=ADMIN)).json()
    assert not three["ok"] and "sandbox" in three["problem"]


async def test_run_as_job_proposal_from_a_chat_request(client, fakes, session):
    pid = await add_project(client)
    req = RequestRow(
        kind="chat",
        rule_id="code_job",
        autonomy=1,
        decision_json={
            "job": {"agents": [{"id": "codex"}, {"id": "gone-agent"}], "autonomy": 2, "suggested": True}
        },
    )
    private = RequestRow(kind="chat", private=True, decision_json={})
    session.add_all([req, private])
    await session.commit()
    p = (await client.get(f"/jobs/proposal?request_id={req.id}", headers=ADMIN)).json()
    assert p == {
        "request_id": req.id,
        "private": False,
        "rule": "code_job",
        "suggested": True,
        "agents": ["codex"],
        "autonomy": 2,
    }
    assert (await client.get(f"/jobs/proposal?request_id={private.id}", headers=ADMIN)).json()["private"]
    r = await client.post(
        "/jobs/preview",
        json={"prompt": "x", "project_id": pid, "from_request_id": private.id},
        headers=ADMIN,
    )
    assert r.status_code == 400 and "private" in r.json()["detail"]
    assert (await client.get("/jobs/proposal?request_id=999", headers=ADMIN)).status_code == 404


# --- logs ----------------------------------------------------------------------------------------------
async def test_runs_and_paged_logs_of_earlier_runs(client, fakes, session):
    pc, host = fakes
    j = await start(client, agent="claude-code", autonomy=1)
    await step(j["id"])
    rid = pc.last_run()
    pc.finish(rid, fixture="run_get_claude_plan", stdout="1. Add multiply\n")
    await step(j["id"])
    runs = (await client.get(f"/jobs/{j['id']}/runs", headers=ADMIN)).json()["runs"]
    assert [(r["run"], r["kind"], r["status"]) for r in runs] == [(rid, "read_only", "succeeded")]
    page = (await client.get(f"/jobs/{j['id']}/log?run={rid}", headers=ADMIN)).json()
    assert page["lines"] and page["next"] is not None
    end = (await client.get(f"/jobs/{j['id']}/log?run={rid}&offset={page['next']}", headers=ADMIN)).json()
    assert end["lines"] == [] and end["next"] is None
    assert (await client.get(f"/jobs/{j['id']}/log?run=run-9999", headers=ADMIN)).status_code == 404


# --- fleet ---------------------------------------------------------------------------------------------
async def test_hire_edit_pause_and_soft_delete(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    r = await client.post(
        "/agents",
        json={
            "template": "claude-code",
            "label": "Reviewer",
            "role": "You review code for bugs. Be brief.",
            "model": "claude-haiku-5-5",
            "default_autonomy": 0,
            "monthly_list_usd": 5,
            "allowed_project_ids": [pid],
        },
        headers=ADMIN,
    )
    assert r.status_code == 201, r.text
    a = r.json()
    assert (a["id"], a["template"], a["hired"], a["model"]) == (
        "reviewer",
        "claude-code",
        True,
        "claude-haiku-5-5",
    )
    assert a["monthly_budget_list_usd"] == 5 and a["allowed_project_ids"] == [pid]

    # validation in plain words
    bad = [
        ({"template": "codex", "label": "X", "model": "gpt-9"}, "own default model"),
        ({"template": "claude-code", "label": "Y", "model": "gpt-9"}, "claude-sonnet-5-5"),
        ({"template": "claude-code", "label": "Z", "default_autonomy": 3}, "Level 3 is off"),
        ({"template": "hermes", "label": "H"}, "Not verified"),
        ({"template": "claude-code", "label": "reviewer"}, "already exists"),
        ({"template": "claude-code", "label": "P", "allowed_project_ids": [999]}, "Projects list"),
    ]
    for body, why in bad:
        r = await client.post("/agents", json=body, headers=ADMIN)
        assert r.status_code in (400, 409) and why in r.json()["detail"], (body, r.text)

    # the hired agent's defaults apply: autonomy 0, its role first in the task, its model
    j = await job(client, pid, agents=["reviewer"])
    assert j["autonomy"] == 0 and j["agent"] == "reviewer" and j["agent_label"] == "Reviewer"
    await step(j["id"])
    pa = pc.agents[pc.wakes[-1]["agent"]]
    assert pa["name"] == "Switchboard Reviewer" and pa["adapterConfig"]["model"] == "claude-haiku-5-5"
    assert pc.instructions[pa["id"]].count("Your role: You review code for bugs.") == 1

    # rename → Paperclip follows (name only)
    r = await client.patch("/agents/reviewer", json={"label": "Bug reviewer"}, headers=ADMIN)
    assert r.status_code == 200 and pa["name"] == "Switchboard Bug reviewer"

    # can't delete while a job is in progress; pause still works but isn't mirrored mid-job
    assert (await client.delete("/agents/reviewer", headers=ADMIN)).status_code == 409
    assert (await client.post("/agents/reviewer/pause", headers=ADMIN)).json()["paused"] is True
    assert pc.state_calls == []
    await client.post(f"/jobs/{j['id']}/stop", headers=ADMIN)
    assert (await client.post("/agents/reviewer/pause", headers=ADMIN)).json()["paused"] is True
    assert pc.state_calls == [(pa["id"], "pause")]
    assert (await client.post("/agents/reviewer/resume", headers=ADMIN)).json()["paused"] is False
    assert pc.state_calls[-1] == (pa["id"], "resume")

    # soft delete: hidden from the fleet and pickers, old jobs keep the name, Paperclip agent terminated
    assert (await client.delete("/agents/reviewer", headers=ADMIN)).json() == {"deleted": True}
    assert (await client.delete("/agents/reviewer", headers=ADMIN)).json() == {"deleted": True}  # again: ok
    assert pc.state_calls[-1] == (pa["id"], "terminate")
    ids = [x["id"] for x in (await client.get("/agents", headers=ADMIN)).json()["agents"]]
    assert "reviewer" not in ids
    old = (await client.get(f"/jobs/{j['id']}", headers=ADMIN)).json()
    assert old["agent_label"] == "Bug reviewer"
    r = await client.post(
        "/jobs", json={"prompt": "x", "project_id": pid, "agents": ["reviewer"]}, headers=ADMIN
    )
    assert r.status_code == 400
    # a new agent with the same name gets a fresh id (history stays with the old one)
    again = await client.post("/agents", json={"template": "codex", "label": "Reviewer"}, headers=ADMIN)
    assert again.status_code == 201 and again.json()["id"] == "reviewer-2"
    assert (await client.delete("/agents/claude-code", headers=ADMIN)).status_code == 400


async def test_edit_and_reset_a_built_in_agent(client, fakes, session):
    pc, host = fakes
    r = await client.patch(
        "/agents/claude-code", json={"model": "claude-opus-5-5", "default_autonomy": 2}, headers=ADMIN
    )
    assert r.status_code == 200 and r.json()["edited"] and r.json()["model"] == "claude-opus-5-5"
    rows = {a["id"]: a for a in (await client.get("/agents", headers=ADMIN)).json()["agents"]}
    assert rows["claude-code"]["edited"] and rows["claude-code"]["default_autonomy"] == 2
    r = await client.post("/agents/claude-code/reset", headers=ADMIN)
    assert r.status_code == 200 and not r.json()["edited"] and r.json()["model"] == "claude-sonnet-5-5"
    assert (await client.post("/agents/claude-code/reset", headers=ADMIN)).status_code == 200  # idempotent
    assert (await client.patch("/agents/nobody", json={"role": "x"}, headers=ADMIN)).status_code == 404


async def test_paused_disallowed_and_monthly_budget_agents_are_skipped(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    other = (await client.post("/projects", json={"path": "/home/user/other"}, headers=ADMIN)).json()["id"]
    await client.post("/agents/claude-code/pause", headers=ADMIN)
    await client.patch("/agents/codex", json={"allowed_project_ids": [other]}, headers=ADMIN)
    await client.patch("/agents/opencode", json={"monthly_list_usd": 1}, headers=ADMIN)
    # no agent in the chain may work here: refused before anything is created
    r = await client.post(
        "/jobs", json={"prompt": "x", "project_id": pid, "agents": ["codex"]}, headers=ADMIN
    )
    assert r.status_code == 400 and "may work in this project" in r.json()["detail"]
    # this month's list price used up for opencode (an earlier opencode job's cost)
    earlier = await job(client, pid, agents=["opencode"], autonomy=0)
    await client.post(f"/jobs/{earlier['id']}/stop", headers=ADMIN)
    session.add(
        Cost(
            request_id=earlier["request_id"], source="paperclip", list_price_usd=1.5, cost_usd=0, provider="x"
        )
    )
    await session.commit()
    j = await job(client, pid, agents=["claude-code", "codex", "opencode"], autonomy=1)
    p = (
        await client.post(
            "/jobs/preview",
            json={"prompt": "x", "project_id": pid, "agents": ["claude-code", "codex", "opencode"]},
            headers=ADMIN,
        )
    ).json()
    reasons = {x["id"]: x["reason"] for x in p["agents"]}
    assert "paused" in reasons["claude-code"] and "isn't allowed" in reasons["codex"]
    assert "this month's budget" in reasons["opencode"] and not p["ok"]
    await step(j["id"])
    done = await get(session, j["id"])
    assert done.status == "failed", (done.status, done.error)
    assert "paused" in done.error and "month" in done.error


# --- approval expiry and retention -------------------------------------------------------------------
async def test_a_job_waiting_too_long_for_approval_is_stopped(client, fakes, session):
    pc, host = fakes
    await client.put("/settings", json={"approval_expiry_h": 2}, headers=ADMIN)
    j = await start(client, agent="claude-code", autonomy=1)
    await step(j["id"])
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")
    await step(j["id"])
    view = (await client.get(f"/jobs/{j['id']}", headers=ADMIN)).json()
    assert view["status"] == "needs_approval" and view["approval_expires_at"]
    await step(j["id"])  # not yet
    assert (await get(session, j["id"])).status == "needs_approval"
    await session.execute(
        update(JobEvent)
        .where(JobEvent.job_id == j["id"], JobEvent.kind == "needs_approval")
        .values(created_at=jobs.now() - timedelta(hours=3))
    )
    await session.commit()
    await step(j["id"])
    done = await get(session, j["id"])
    assert done.status == "stopped" and "Waited 2 h for your approval of the plan" in done.error
    assert done.worktree_removed and any(a["status"] == "rejected" for a in pc.approvals.values())
    kinds = [e.kind for e in (await session.scalars(select(JobEvent).where(JobEvent.job_id == j["id"])))]
    assert "approval_expired" in kinds
    # 0 = never expires
    s = (await client.put("/settings", json={"approval_expiry_h": 0}, headers=ADMIN)).json()
    assert s["approval_expiry_h"] == 0


async def test_retention_setting_and_read_only_worktree_listing(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    s = (await client.get("/settings")).json()
    assert s["keep_worktrees_per_project"] == 10 and s["defaults"]["approval_expiry_h"] == 24
    await client.put("/settings", json={"keep_worktrees_per_project": 0}, headers=ADMIN)
    j = await job(client, pid, agent="codex", autonomy=2)
    await step(j["id"])
    pc.finish(pc.last_run(), fixture="run_get_codex-proc")
    await step(j["id"])
    await client.post(f"/jobs/{j['id']}/approve", json={}, headers=ADMIN)
    assert (await get(session, j["id"])).status == "done"
    listing = (await client.get(f"/projects/{pid}/worktrees", headers=ADMIN)).json()
    assert listing["keep"] == 0 and [w["job_id"] for w in listing["worktrees"]] == [j["id"]]
    assert host.removed == []  # listing has no side effects
    await client.post(f"/projects/{pid}/cleanup", headers=ADMIN)
    assert host.removed == [j["id"]]  # keep 0: the done job's worktree goes, its branch stays
    assert (await client.get("/projects/999/worktrees", headers=ADMIN)).status_code == 404


# --- status -----------------------------------------------------------------------------------------------
async def test_status_shows_paperclip_auth_and_the_loopback_check(client, fakes, mock_http):
    system._probe_cache.clear()
    mock_http.get(url__regex=rf"{HP}/net/listen").respond(
        200, json={"port": 3100, "addresses": ["127.0.0.1"], "loopback_only": True}
    )
    comps = {c["id"]: c for c in (await client.get("/system/components")).json()["components"]}
    pc = comps["paperclip"]
    assert pc["status"] == "ok" and "No login (local only)" in pc["detail"]
    assert pc["notes"]["auth"] == "local_trusted"
    assert pc["notes"]["loopback"] == {"checked": True, "ok": True, "addresses": ["127.0.0.1"], "port": 3100}

    system._probe_cache.clear()
    mock_http.get(url__regex=rf"{HP}/net/listen").respond(
        200,
        json={"port": 3100, "addresses": ["0.0.0.0"], "loopback_only": False},  # noqa: S104
    )
    comps = {c["id"]: c for c in (await client.get("/system/components")).json()["components"]}
    assert comps["paperclip"]["status"] == "down" and comps["paperclip"]["notes"]["loopback"]["ok"] is False
    system._probe_cache.clear()
