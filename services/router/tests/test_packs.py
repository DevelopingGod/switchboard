"""Workflow packs in the router (M4.5a, ADRs 0018-0019): registry, per-project settings, OpenSpec flow jobs,
graphify's holdout, cached tokens, the API. hostprobe is faked (its own tests cover the store and setup)."""

import json
import shutil
from pathlib import Path

import httpx
import pytest
import yaml
from sqlalchemy import select

from app.agents import load_agents
from app.config import get_settings
from app.job_output import outcome
from app.models import Cost, Job, JobEvent, PackInstall, Project
from app.packs import registry
from app.packs import service as packs
from tests.conftest import ADMIN
from tests.test_jobs import HP, FakeHost, FakePaperclip, add_project, fx, get, step

SHIPPED = Path(get_settings().packs_dir)


@pytest.fixture
def packs_dir(tmp_path):
    """A copy of the shipped packs/ to edit; restored afterwards."""
    s = get_settings()
    old = s.packs_dir
    d = tmp_path / "packs"
    shutil.copytree(SHIPPED, d)
    s.packs_dir = d
    registry._cache = None
    yield d
    s.packs_dir = old
    registry._cache = None


# --- registry -----------------------------------------------------------------------------------------------
def test_shipped_packs_load_with_matching_locks():
    reg = registry.load()
    assert reg.errors == {}
    os_, gr, gs = reg.get("openspec"), reg.get("graphify"), reg.get("gstack")
    assert os_.installable and (os_.kind, os_.package, os_.version) == (
        "npm",
        "@fission-ai/openspec",
        "2.1.1",
    )
    assert gr.installable and (gr.kind, gr.package) == ("pypi", "graphifyy") and gr.auto == "graph"
    assert "graphify" in gr.lookalikes  # the typosquat-prone name, documented
    assert [s.skill for s in os_.flow("change").steps] == [
        "openspec-propose",
        "openspec-apply-change",
        "openspec-archive-change",
    ]
    assert os_.invoke_for("codex", "openspec-propose") == "$openspec-propose"
    assert os_.invoke_for("claude-code", "openspec-propose") == "/openspec-propose"
    # gstack only installs into ~/.claude/skills: listed, refused with a plain reason
    assert not gs.installable and "home folder" in gs.refused and gs.trust == "community"


def _edit(d: Path, pid: str, change) -> None:
    p = d / pid / "pack.yaml"
    raw = yaml.safe_load(p.read_text())
    change(raw)
    p.write_text(yaml.safe_dump(raw))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda r: r.update(source="npm:@fission-ai/openspec@latest"), "exact package and version"),
        (lambda r: r.update(source="npm:@fission-ai/openspec@^2.1.0"), "never a range"),
        (lambda r: r.update(scope=["global"], refused=None), "why it is refused"),
        (lambda r: r["project"]["setup"].append(["openspec", "{worktree}"]), "only placeholders"),
        (lambda r: r["project"]["setup"].append(["bash", "-c", "x"]), "not one of the pack's programs"),
        (lambda r: r["hosts"].update(cursor="cursor"), "unknown host"),
        (lambda r: r.update(owned=["../outside/**"]), "inside the project"),
        (lambda r: r.update(owned=[".switchboard/**"]), "inside the project"),
        (lambda r: r.update(lookalikes=["@fission-ai/openspec"]), "own package"),
        (lambda r: r.update(requires=["node>=latest"]), "like node>=22.20"),
    ],
)
def test_manifest_validation(packs_dir, change, message):
    _edit(packs_dir, "openspec", change)
    reg = registry.load()
    assert "openspec" not in reg.packs
    assert message in reg.errors["openspec"]


def test_a_lock_that_no_longer_matches_its_manifest_blocks_install(packs_dir):
    _edit(packs_dir, "openspec", lambda r: r["env"].update(EXTRA="1"))
    p = registry.load().get("openspec")
    assert not p.installable and "doesn't match its manifest" in p.lock_problem
    (packs_dir / "graphify" / "pack.lock.json").unlink()
    assert "no lock yet" in registry.load().get("graphify").lock_problem


# --- cached tokens (ADR 0019) ------------------------------------------------------------------------------
def test_cached_input_tokens_per_cli():
    reg = load_agents()
    claude = outcome(reg.agents["claude-code"], fx("run_get_claude_plan"))
    assert (claude.tokens_in, claude.tokens_cached, claude.tokens_out) == (13917, 31815, 384)
    codex = outcome(reg.agents["codex"], fx("run_get_codex-proc"))
    assert (
        codex.tokens_cached == 91520 and codex.tokens_in == 100015 - 91520
    )  # Codex counts cached inside input
    oc = outcome(reg.agents["opencode"], fx("run_get_opencode-proc"))
    assert oc.tokens_cached == 11264 + 11776 * 3 + 12288 * 3 + 12800 * 2
    assert oc.tokens_in == 11848 + 735 + 361 + 520 + 704 + 398 + 590 + 671 + 420 + 547


# --- project settings ---------------------------------------------------------------------------------------
async def test_project_pack_settings_api(client, pfakes, session):
    pid = await add_project(client)
    r = await client.get(f"/projects/{pid}/packs", headers=ADMIN)
    st = r.json()["packs"]
    assert st["openspec"] == {"enabled": False, "hosts": ["claude-code", "codex", "opencode"]}
    assert st["graphify"]["mode"] == "auto" and st["graphify"]["groups"] == []
    assert "gstack" not in st  # refused packs have no project settings
    r = await client.put(
        f"/projects/{pid}/packs",
        json={
            "packs": {"openspec": {"enabled": True, "hosts": ["claude-code"]}, "graphify": {"mode": "always"}}
        },
        headers=ADMIN,
    )
    assert r.status_code == 200, r.text
    assert r.json()["packs"]["openspec"] == {"enabled": True, "hosts": ["claude-code"]}
    for bad in (
        {"gstack": {"enabled": True}},
        {"openspec": {"hosts": ["cursor"]}},
        {"graphify": {"mode": "sometimes"}},
        {"openspec": {"enabled": "yes"}},
    ):
        r = await client.put(f"/projects/{pid}/packs", json={"packs": bad}, headers=ADMIN)
        assert r.status_code == 400, bad


# --- OpenSpec as one job: propose → apply → archive ---------------------------------------------------------
class PackHost(FakeHost):
    """FakeHost plus hostprobe's pack routes: the setup task and its record."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.packs = [{"id": "openspec", "current": "2.1.1"}, {"id": "graphify", "current": "0.9.115"}]
        self.setups: list[dict] = []
        self.size = {"files": 20, "bytes": 30_000}
        self.diff_setup_edits = []
        self.refuse: dict[str, str] = {}

    def install(self, m):
        super().install(m)
        m.post(f"{HP}/git/worktrees/packs").mock(side_effect=self._setup)
        m.get(url__regex=rf"{HP}/packs/tasks/").mock(side_effect=self._task)
        m.post(f"{HP}/git/worktrees/size").mock(side_effect=lambda r: httpx.Response(200, json=self.size))

    def _record(self, reqs):
        rec = {"state": "ready", "packs": {}, "refused": [], "bins": []}
        for r in reqs:
            if r["id"] in self.refuse:
                rec["refused"].append({"id": r["id"], "reason": self.refuse[r["id"]]})
                continue
            rec["packs"][r["id"]] = {
                "name": r["id"],
                "version": "1",
                "owned_dirs": [".agents/skills/x"] if r["id"] == "openspec" else ["graphify-out"],
                "owned_files": [],
                "artifacts": ["openspec/config.yaml"] if r["id"] == "openspec" else [],
                "edits": [] if r["id"] == "openspec" else [{"path": "AGENTS.md", "kind": "modified"}],
                "steps": [{"argv": "x", "ms": 1200, "exit": 0}],
                "verify_ms": 70,
                "graph": bool(r.get("graph")),
                "graph_stats": {"nodes": 42} if r.get("graph") else None,
                "bin": f"/home/user/.switchboard/packs/{r['id']}/1/sbbin",
            }
            rec["bins"].append(f"/home/user/.switchboard/packs/{r['id']}/1/sbbin")
        return rec

    def _setup(self, r):
        b = json.loads(r.content)
        self.setups.append(b)
        return httpx.Response(200, json={"id": f"t{len(self.setups)}", "state": "running"})

    def _task(self, r):
        n = int(r.url.path.rsplit("t", 1)[1])
        return httpx.Response(
            200, json={"id": f"t{n}", "state": "ok", "result": self._record(self.setups[n - 1]["packs"])}
        )


@pytest.fixture
def pfakes(mock_http, litellm):
    pc, host = FakePaperclip(), PackHost()
    pc.install(mock_http)
    host.install(mock_http)
    packs.forget_installed()
    return pc, host


async def _openspec_on(client, pid, hosts=("claude-code",)):
    r = await client.put(
        f"/projects/{pid}/packs",
        json={"packs": {"openspec": {"enabled": True, "hosts": list(hosts)}}},
        headers=ADMIN,
    )
    assert r.status_code == 200


async def test_flow_refusals_and_preview(client, pfakes, session):
    pid = await add_project(client)
    body = {
        "prompt": "Add multiply",
        "project_id": pid,
        "agent": "claude-code",
        "autonomy": 1,
        "flow": "openspec.change",
    }
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 400 and "isn't turned on for this project" in r.json()["detail"]
    await _openspec_on(client, pid, hosts=("codex",))
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 400 and "isn't set up for Claude Code" in r.json()["detail"]
    await _openspec_on(client, pid)
    r = await client.post("/jobs", json={**body, "autonomy": 0}, headers=ADMIN)
    assert r.status_code == 400 and "autonomy 1 or more" in r.json()["detail"]
    r = await client.post("/jobs", json={**body, "flow": "openspec.nope"}, headers=ADMIN)
    assert r.status_code == 400
    r = await client.post("/jobs/preview", json=body, headers=ADMIN)
    pv = r.json()
    assert pv["ok"] and pv["flow"] == "openspec.change"
    assert any("Propose, Apply, Archive" in s for s in pv["steps"])
    assert any("never committed" in s for s in pv["steps"])


async def test_openspec_flow_one_job_three_steps(client, pfakes, session):
    pc, host = pfakes
    pid = await add_project(client)
    await _openspec_on(client, pid)
    r = await client.post(
        "/jobs",
        json={
            "prompt": "Add multiply(a, b)",
            "project_id": pid,
            "agent": "claude-code",
            "autonomy": 1,
            "flow": "openspec.change",
        },
        headers=ADMIN,
    )
    assert r.status_code == 201, r.text
    jid = r.json()["id"]
    await step(jid)  # worktree, then the pack setup starts (background)
    j = await get(session, jid)
    assert j.status == "queued" and j.packs["state"] == "setting_up"
    assert host.setups[0]["packs"] == [{"id": "openspec", "hosts": ["claude-code"]}]  # graphify: below Auto
    assert "below the Auto threshold" in j.packs["graphify"]["reason"]
    await step(jid)  # setup done -> the first step runs
    j = await get(session, jid)
    assert j.status == "running" and j.phase == "edit" and j.packs["state"] == "ready"
    run = pc.runs[pc.last_run()]
    assert "Step 1 of 3: Propose" in run["instructions"] and "/openspec-propose" in run["instructions"]
    assert run["config"]["env"]["PATH"].startswith("/home/user/.switchboard/packs/openspec/1/sbbin:")
    assert "Bash(openspec:*)" in run["config"]["extraArgs"]
    for n, label in ((2, "Apply"), (3, "Archive")):
        pc.finish(pc.last_run(), fixture="run_get_claude_edit")
        await step(jid)
        j = await get(session, jid)
        assert (j.status, j.gate) == ("needs_approval", "step")
        r = await client.get(f"/jobs/{jid}", headers=ADMIN)
        assert r.json()["flow_step"]["index"] == n - 2
        r = await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
        assert r.json()["status"] == "queued"
        await step(jid)
        run = pc.runs[pc.last_run()]
        assert f"Step {n} of 3: {label}" in run["instructions"]
    pc.finish(pc.last_run(), fixture="run_get_claude_edit")
    await step(jid)
    j = await get(session, jid)
    assert (j.status, j.gate) == ("needs_approval", "diff")
    r = await client.post(f"/jobs/{jid}/approve", json={"include_setup_edits": ["AGENTS.md"]}, headers=ADMIN)
    assert r.json()["status"] == "done"
    assert host.committed == [jid]
    kinds = [e.kind for e in (await session.scalars(select(JobEvent).where(JobEvent.job_id == jid))).all()]
    assert "packs_setup" in kinds and "packs_ready" in kinds and kinds.count("run_started") == 3


async def test_a_flow_job_fails_plainly_when_its_pack_cant_be_set_up(client, pfakes, session):
    pc, host = pfakes
    host.refuse["openspec"] = "openspec 2.1.1 changed on disk since it was installed — reinstall it"
    pid = await add_project(client)
    await _openspec_on(client, pid)
    r = await client.post(
        "/jobs",
        json={
            "prompt": "x",
            "project_id": pid,
            "agent": "claude-code",
            "autonomy": 1,
            "flow": "openspec.change",
        },
        headers=ADMIN,
    )
    jid = r.json()["id"]
    await step(jid, 2)
    j = await get(session, jid)
    assert j.status == "failed" and "changed on disk" in j.error


# --- graphify (ADR 0019) ------------------------------------------------------------------------------------
async def _plain_job(client, pid, agent="claude-code"):
    r = await client.post(
        "/jobs",
        json={"prompt": "Fix it", "project_id": pid, "agent": agent, "autonomy": 2},
        headers=ADMIN,
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_graphify_auto_threshold_always_and_off(client, pfakes, session):
    pc, host = pfakes
    pid = await add_project(client)
    host.size = {"files": 5000, "bytes": 10}
    jid = await _plain_job(client, pid)
    await step(jid, 2)
    j = await get(session, jid)
    assert j.packs["graphify"]["used"] and j.packs["graphify"]["nodes"] == 42
    run = pc.runs[pc.last_run()]
    assert "graphify query" in run["instructions"]  # the pack's note
    assert "Bash(graphify query:*)" in run["config"]["extraArgs"]
    # Off: no graph, no size asked
    await client.put(f"/projects/{pid}/packs", json={"packs": {"graphify": {"mode": "off"}}}, headers=ADMIN)
    jid2 = await _plain_job(client, pid, "codex")  # another agent: Claude Code is busy with the first job
    n = len(host.setups)
    await step(jid2)
    j2 = await get(session, jid2)
    assert j2.packs["graphify"]["reason"] == "Off for this project" and len(host.setups) == n
    # not installed: no graph
    host.packs = []
    packs.forget_installed()
    await client.put(
        f"/projects/{pid}/packs", json={"packs": {"graphify": {"mode": "always"}}}, headers=ADMIN
    )
    jid3 = await _plain_job(client, pid, "opencode")
    await step(jid3)
    assert "isn't installed" in (await get(session, jid3)).packs["graphify"]["reason"]


async def _done_job(session, project, agent, used, tokens, rnd=1, flow=None, cached=0):
    j = Job(
        project_id=project.id,
        title="t",
        prompt="p",
        agent=agent,
        agent_chain=[agent],
        autonomy=2,
        status="done",
        budget_list_usd=2,
        flow=flow,
        packs={
            "graphify": {
                "eligible": True,
                "used": used,
                "control": not used,
                "round": rnd,
                "group": packs.group_key(agent, flow),
            }
        },
    )
    session.add(j)
    await session.flush()
    j.finished_at = j.created_at
    session.add(
        Cost(
            source="paperclip",
            tokens_in=tokens - cached,
            tokens_cached=cached,
            tokens_out=0,
            job_id=j.id,
            kind="job",
            external_id=f"t-{j.id}",
        )
    )
    await session.commit()
    return j


async def test_holdout_every_fifth_then_decide_then_recheck(client, pfakes, session):
    pc, host = pfakes
    pid = await add_project(client)
    project = await session.get(Project, pid)
    reg = load_agents()
    agent = reg.agents["claude-code"]
    await client.put(
        f"/projects/{pid}/packs", json={"packs": {"graphify": {"mode": "always"}}}, headers=ADMIN
    )
    await session.refresh(project)
    job = Job(project_id=pid, agent="claude-code", flow=None)
    arms = []
    for _ in range(10):
        d = await packs.graph_decision(session, project, agent, job, None)
        arms.append("control" if d["control"] else "graph")
    assert arms == ["graph"] * 4 + ["control"] + ["graph"] * 4 + ["control"]
    group = packs.group_key("claude-code", None)
    m = project.packs["graphify"]["measure"][group]
    assert m["state"] == "measuring"
    assert packs.status_line(m, (4, 1)) == "Measuring (1 of 5)"
    # 5 + 5 finished samples: the graph saves 40% -> on
    for _ in range(5):
        await _done_job(session, project, "claude-code", True, 6000, cached=4000)
        await _done_job(session, project, "claude-code", False, 10000, cached=7000)
    decided = await packs.reconsider(session, project, group)
    assert decided["state"] == "on" and decided["gain"] == 0.4
    m = project.packs["graphify"]["measure"][group]
    assert packs.status_line(m, (5, 5)) == "Saves 40% tokens (rechecks in 20 jobs)"
    # once decided: no holdouts until the re-check
    arms = [(await packs.graph_decision(session, project, agent, job, None))["control"] for _ in range(19)]
    assert not any(arms)
    d = await packs.graph_decision(session, project, agent, job, None)  # the 20th: a new round starts
    m = project.packs["graphify"]["measure"][group]
    assert (m["state"], m["round"], m["arm"]) == ("measuring", 2, "control")
    # flow jobs are another group, never mixed with plain jobs
    fj = Job(project_id=pid, agent="claude-code", flow="openspec.change")
    d = await packs.graph_decision(session, project, agent, fj, None)
    assert d["group"] == "claude-code|openspec.change"


async def test_no_gain_turns_graphify_off_for_the_group_and_metrics_say_so(client, pfakes, session):
    pid = await add_project(client)
    project = await session.get(Project, pid)
    group = packs.group_key("claude-code", None)
    project.packs = {
        "graphify": {
            "mode": "always",
            "hosts": ["claude-code"],
            "measure": {group: {"state": "measuring", "round": 1, "seen": 10, "arm": "both"}},
        }
    }
    await session.commit()
    for _ in range(5):
        await _done_job(session, project, "claude-code", True, 9800)
        await _done_job(session, project, "claude-code", False, 10000)
    decided = await packs.reconsider(session, project, group)
    assert decided["state"] == "off"
    await session.commit()
    r = await client.get("/metrics/packs", headers=ADMIN)
    row = r.json()["rows"][0]
    assert row["status"] == "Off: no gain (rechecks in 20 jobs)" and row["samples_with"] == 5
    assert row["median_with"] == 9800 and row["median_without"] == 10000
    reg = load_agents()
    d = await packs.graph_decision(
        session, project, reg.agents["claude-code"], Job(project_id=pid, agent="claude-code"), None
    )
    assert not d["used"] and "no token gain" in d["reason"]
    # Turn back on: a fresh round
    r = await client.put(
        f"/projects/{pid}/packs", json={"packs": {"graphify": {"turn_back_on": True}}}, headers=ADMIN
    )
    assert r.json()["packs"]["graphify"]["groups"] == []


# --- the library API ----------------------------------------------------------------------------------------
async def test_library_install_flow_and_records(client, pfakes, session, mock_http):
    pc, host = pfakes
    plan = {
        "id": "openspec",
        "plan_id": "p" * 20,
        "version": "2.1.1",
        "source": "https://www.npmjs.com/x",
        "commands": ["download"],
        "writes": ["~/.switchboard/packs/openspec/2.1.1"],
        "problem": None,
    }
    mock_http.post(f"{HP}/packs/openspec/plan").respond(200, json=plan)
    mock_http.post(f"{HP}/packs/openspec/run").respond(202, json={"id": "job1", "state": "running"})
    mock_http.post(f"{HP}/packs/openspec/rollback").respond(
        409, json={"error": "there is no previous version"}
    )
    r = await client.get("/packs", headers=ADMIN)
    lib = {p["id"]: p for p in r.json()["packs"]}
    assert (
        lib["openspec"]["installed"] == "2.1.1"
        and lib["gstack"]["refused"]
        and not lib["gstack"]["installable"]
    )
    assert lib["openspec"]["flows"][0]["id"] == "openspec.change"
    r = await client.post("/packs/gstack/install-plan", headers=ADMIN)
    assert r.status_code == 403 and "home folder" in r.json()["detail"]
    r = await client.post("/packs/openspec/install-plan", headers=ADMIN)
    assert r.status_code == 200 and r.json()["unverified"] is False
    r = await client.post("/packs/openspec/install", json={"plan_id": "p" * 20}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["id"] == "job1"
    row = (await session.scalars(select(PackInstall))).one()
    assert (row.action, row.status, row.summary_json["source"]) == (
        "install",
        "running",
        "https://www.npmjs.com/x",
    )
    r = await client.post("/packs/openspec/rollback", headers=ADMIN)
    assert r.status_code == 409 and "no previous version" in r.json()["detail"]
    rows = (await session.scalars(select(PackInstall).order_by(PackInstall.id))).all()
    assert [(x.action, x.status) for x in rows] == [("install", "running"), ("rollback", "failed")]


async def test_unverified_packs_need_an_extra_confirm(client, pfakes, packs_dir, mock_http):
    _edit(packs_dir, "openspec", lambda r: r.update(trust="community"))
    raw = yaml.safe_load((packs_dir / "openspec" / "pack.yaml").read_text())
    lock = json.loads((packs_dir / "openspec" / "pack.lock.json").read_text())
    lock["spec"] = registry.spec_of(raw)
    (packs_dir / "openspec" / "pack.lock.json").write_text(json.dumps(lock))
    mock_http.post(f"{HP}/packs/openspec/run").respond(202, json={"id": "job2", "state": "running"})
    r = await client.post("/packs/openspec/install", json={"plan_id": "q" * 20}, headers=ADMIN)
    assert r.status_code == 400 and "unverified" in r.json()["detail"]
    r = await client.post(
        "/packs/openspec/install", json={"plan_id": "q" * 20, "accept_unverified": True}, headers=ADMIN
    )
    assert r.status_code == 200


async def test_health_reports_packs(client, pfakes):
    r = await client.get("/health")
    assert r.json()["packs"] == "ok (3 packs)"
