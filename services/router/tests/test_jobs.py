"""Agent jobs end to end against a fake Paperclip and a fake hostprobe (M4a, ADR 0007/0008).

The fakes follow the recorded shapes (tests/fixtures/paperclip/) and keep state, so the real job engine and
API drive them through whole jobs: plan → approval → edit → diff → done, rejection, stop, fallbacks, caps.
"""

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from app import jobs
from app.agents import load_agents
from app.models import Cost, Job, JobEvent, Project
from app.models import Request as RequestRow
from app.paperclip import Paperclip
from app.routing.context import spent_today
from tests.conftest import ADMIN

PC = "http://paperclip.test/api"
HP = "http://hostprobe.test"
FIX = Path(__file__).parent / "fixtures" / "paperclip"
REPO = "/home/user/playground"


def fx(name: str) -> dict:
    return json.loads((FIX / f"{name}.json").read_text())["response"]


class FakePaperclip:
    def __init__(self):
        self.agents: dict[str, dict] = {}
        self.instructions: dict[str, str] = {}
        self.runs: dict[str, dict] = {}
        self.logs: dict[str, str] = {}
        self.wakes: list[dict] = []
        self.issues: dict[str, dict] = {}
        self.approvals: dict[str, dict] = {}
        self.comments: list[str] = []
        self.cancelled: list[str] = []
        self.n = 0
        self.company = None
        self.ready_after_retry = True
        self.state_calls: list[tuple[str, str]] = []

    def nid(self, p: str) -> str:
        self.n += 1
        return f"{p}-{self.n:04d}"

    def install(self, mock):
        m = mock
        m.get(f"{PC}/health").respond(200, json=fx("health"))
        m.get(f"{PC}/companies").mock(
            side_effect=lambda r: httpx.Response(200, json=[self.company] if self.company else [])
        )
        m.post(f"{PC}/companies").mock(side_effect=self._company)
        m.get(url__regex=rf"{PC}/companies/[^/]+/agents$").mock(
            side_effect=lambda r: httpx.Response(200, json=list(self.agents.values()))
        )
        m.post(url__regex=rf"{PC}/companies/[^/]+/agents$").mock(side_effect=self._agent_create)
        m.get(url__regex=rf"{PC}/agents/[^/]+$").mock(side_effect=self._agent_get)
        m.patch(url__regex=rf"{PC}/agents/[^/]+$").mock(side_effect=self._agent_patch)
        m.put(url__regex=rf"{PC}/agents/[^/]+/instructions-bundle/file$").mock(side_effect=self._instructions)
        m.get(url__regex=rf"{PC}/agents/[^/]+/instructions-bundle/file").mock(
            side_effect=self._instructions_get
        )
        m.post(url__regex=rf"{PC}/agents/[^/]+/lifecycle/retry$").mock(side_effect=self._retry)
        m.post(url__regex=rf"{PC}/agents/[^/]+/clear-error$").mock(side_effect=self._clear_error)
        m.post(url__regex=rf"{PC}/agents/[^/]+/wakeup$").mock(side_effect=self._wake)
        m.post(url__regex=rf"{PC}/agents/[^/]+/(pause|resume|terminate)$").mock(side_effect=self._agent_state)
        m.get(url__regex=rf"{PC}/heartbeat-runs/[^/]+$").mock(side_effect=self._run_get)
        m.get(url__regex=rf"{PC}/heartbeat-runs/[^/]+/log").mock(side_effect=self._log)
        m.post(url__regex=rf"{PC}/heartbeat-runs/[^/]+/cancel$").mock(side_effect=self._cancel)
        m.post(url__regex=rf"{PC}/companies/[^/]+/issues$").mock(side_effect=self._issue_create)
        m.patch(url__regex=rf"{PC}/issues/[^/]+$").mock(side_effect=self._issue_patch)
        m.post(url__regex=rf"{PC}/issues/[^/]+/comments$").mock(side_effect=self._comment)
        m.post(url__regex=rf"{PC}/companies/[^/]+/approvals$").mock(side_effect=self._approval_create)
        m.get(url__regex=rf"{PC}/approvals/[^/]+$").mock(side_effect=self._approval_get)
        m.post(url__regex=rf"{PC}/approvals/[^/]+/(approve|reject)$").mock(side_effect=self._approval_decide)

    def _company(self, r):
        self.company = {"id": "co-1", "name": json.loads(r.content)["name"]}
        return httpx.Response(201, json=self.company)

    def _agent_create(self, r):
        b = json.loads(r.content)
        a = {
            "id": self.nid("ag"),
            "name": b["name"],
            "adapterType": b["adapterType"],
            "adapterConfig": b["adapterConfig"],
            "metadata": b.get("metadata"),
            "status": "paused",
            "lifecycleState": "verifying",
            "lifecycleError": None,
        }
        self.agents[a["id"]] = a
        self.instructions[a["id"]] = b["instructionsBundle"]["files"]["AGENTS.md"]
        return httpx.Response(201, json=a)

    def _agent_get(self, r):
        a = self.agents.get(r.url.path.rsplit("/", 1)[1])
        if a is None:
            return httpx.Response(404, json={"error": "Agent not found"})
        if a["lifecycleState"] == "verifying":  # the check passes on the next read
            a.update(status="idle", lifecycleState="ready")
        return httpx.Response(200, json=a)

    def _agent_patch(self, r):
        a = self.agents.get(r.url.path.rsplit("/", 1)[1])
        if a is None:
            return httpx.Response(404, json={"error": "Agent not found"})
        b = json.loads(r.content)
        for k in ("adapterConfig", "name"):
            if k in b:
                a[k] = b[k]
        return httpx.Response(200, json=a)

    def _agent_state(self, r):
        _, aid, action = r.url.path.rsplit("/", 2)
        a = self.agents.get(aid)
        if a is None:
            return httpx.Response(404, json={"error": "Agent not found"})
        self.state_calls.append((aid, action))
        a["status"] = {"pause": "paused", "resume": "idle", "terminate": "terminated"}[action]
        return httpx.Response(200, json=a)

    def _rev(self, aid: str) -> str:
        return hashlib.sha256(self.instructions.get(aid, "").encode()).hexdigest()

    def _instructions_get(self, r):
        aid = r.url.path.split("/")[3]
        return httpx.Response(
            200,
            json={
                "path": "AGENTS.md",
                "content": self.instructions.get(aid, ""),
                "contentHash": self._rev(aid),
                "revision": {"id": "rev-" + self._rev(aid)[:8]},
            },
        )

    def _instructions(self, r):
        aid = r.url.path.split("/")[3]
        b = json.loads(r.content)
        if "baseRevisionId" not in b:  # the real guard (verified live)
            return httpx.Response(
                422, json={"error": "Read the entry and supply baseRevisionId (null for a new entry)"}
            )
        if b["baseRevisionId"] != "rev-" + self._rev(aid)[:8]:
            return httpx.Response(409, json={"error": "stale revision"})
        self.instructions[aid] = b["content"]
        return httpx.Response(200, json={"ok": True})

    def _clear_error(self, r):
        a = self.agents[r.url.path.split("/")[3]]
        a["status"] = "idle"
        self.cleared = getattr(self, "cleared", 0) + 1
        return httpx.Response(200, json=a)

    def _retry(self, r):
        a = self.agents[r.url.path.split("/")[3]]
        if self.ready_after_retry:
            a.update(lifecycleState="verifying")
        return httpx.Response(200, json=a)

    def _wake(self, r):
        aid = r.url.path.split("/")[3]
        b = json.loads(r.content)
        for w in self.wakes:
            if w["body"]["idempotencyKey"] == b["idempotencyKey"]:
                return httpx.Response(202, json={"status": "skipped", "executionRunId": w["run"]})
        rid = self.nid("run")
        self.runs[rid] = {
            "id": rid,
            "agentId": aid,
            "status": "running",
            "scopeKind": "company",
            "startedAt": datetime.now(UTC)
            .isoformat()
            .replace("+00:00", "Z"),  # not a fixed time: caps use it
            "finishedAt": None,
            "error": None,
            "resultJson": None,
            "usageJson": None,
            "config": json.loads(json.dumps(self.agents[aid]["adapterConfig"])),
            "instructions": self.instructions.get(aid),
        }
        self.logs[rid] = ""
        self.wakes.append({"agent": aid, "body": b, "run": rid})
        return httpx.Response(202, json={**self.runs[rid], "status": "queued"})

    def _run_get(self, r):
        run = self.runs.get(r.url.path.rsplit("/", 1)[1])
        return (
            httpx.Response(200, json=run)
            if run
            else httpx.Response(404, json={"error": "Heartbeat run not found"})
        )

    def _log(self, r):
        rid = r.url.path.split("/")[3]
        off = int(r.url.params.get("offset", 0))
        data = self.logs.get(rid, "").encode()[off:]
        return httpx.Response(200, json={"content": data.decode(), "nextOffset": off + len(data)})

    def _cancel(self, r):
        rid = r.url.path.split("/")[3]
        if rid not in self.runs:
            return httpx.Response(404, json={"error": "Heartbeat run not found"})
        self.cancelled.append(rid)
        self.runs[rid].update(status="cancelled", error="Cancelled by a board operator")
        return httpx.Response(200, json=self.runs[rid])

    def _issue_create(self, r):
        b = json.loads(r.content)
        for i in self.issues.values():
            if i["key"] == b["idempotencyKey"]:
                return httpx.Response(200, json=i)
        i = {
            "id": self.nid("iss"),
            "key": b["idempotencyKey"],
            "status": b["status"],
            "assigneeAgentId": None,
            "createdByUserId": "local-board",
            "identifier": f"SWI-{self.n}",
            "title": b["title"],
        }
        self.issues[i["id"]] = i
        return httpx.Response(201, json=i)

    def _issue_patch(self, r):
        i = self.issues[r.url.path.rsplit("/", 1)[1]]
        b = json.loads(r.content)
        if b.get("status") == "in_progress" and not (b.get("assigneeUserId") or i.get("assigneeUserId")):
            return httpx.Response(422, json={"error": "in_progress issues require an assignee"})
        i.update(b)
        return httpx.Response(200, json=i)

    def _comment(self, r):
        self.comments.append(json.loads(r.content)["body"])
        return httpx.Response(201, json={"id": self.nid("c")})

    def _approval_create(self, r):
        b = json.loads(r.content)
        a = {
            "id": self.nid("ap"),
            "status": "pending",
            "type": b["type"],
            "payload": b["payload"],
            "issueIds": b["issueIds"],
        }
        self.approvals[a["id"]] = a
        return httpx.Response(201, json=a)

    def _approval_get(self, r):
        return httpx.Response(200, json=self.approvals[r.url.path.rsplit("/", 1)[1]])

    def _approval_decide(self, r):
        _, aid, action = r.url.path.rsplit("/", 2)
        a = self.approvals[aid]
        a.update(
            status="approved" if action == "approve" else "rejected",
            decisionNote=json.loads(r.content).get("decisionNote"),
        )
        return httpx.Response(200, json=a)

    # test controls
    def finish(self, rid: str, *, status="succeeded", fixture: str | None = None, stdout: str = ""):
        run = self.runs[rid]
        src = fx(fixture) if fixture else {}
        run.update(
            status=status,
            finishedAt="2026-11-20T06:00:30.000Z",
            resultJson=src.get("resultJson") or {"stdout": stdout},
            usageJson=src.get("usageJson") or {},
        )
        out = (src.get("resultJson") or {}).get("stdout") or stdout
        if out:
            self.logs[rid] += json.dumps({"ts": "t", "stream": "stdout", "chunk": out}) + "\n"

    def last_run(self) -> str:
        return self.wakes[-1]["run"]


class FakeHost:
    def __init__(self, installed=("claude", "codex", "opencode"), bwrap=True):
        self.installed = set(installed)
        self.bwrap = bwrap
        self.worktrees: dict[int, dict] = {}
        self.removed: list[int] = []
        self.committed: list[int] = []
        self.messages: list[str] = []
        self.inspect = {
            "is_repo": True,
            "is_top": True,
            "is_self": False,
            "has_commits": True,
            "head_branch": "main",
        }
        # M6.5 routes (accounts, Codex usage numbers, overflow key file): see tests/test_m65.py
        self.accounts: set[tuple[str, str]] = set()
        self.logged_out: set[tuple[str, str]] = set()
        self.plans: dict[tuple[str, str], str] = {("claude", "default"): "pro", ("claude", "work"): "team"}
        self.key_files: dict[str, str] = {}
        self.codex: dict = {"found": False}
        self.codex_calls: list[dict] = []
        self.packs: list[dict] = []  # M4.5a: hostprobe's pack store listing

    def install(self, m):
        m.get(f"{HP}/cli").mock(
            side_effect=lambda r: httpx.Response(
                200,
                json={
                    "clis": {
                        c: {
                            "installed": c in self.installed,
                            "version": "1.0",
                            "logged_in": True if c in self.installed else None,
                            "windows_only": False,
                        }
                        for c in ("claude", "codex", "opencode", "gemini", "grok", "hermes")
                    }
                },
            )
        )
        m.get(f"{HP}/hw").mock(
            side_effect=lambda r: httpx.Response(200, json={"vram_mb": 4096, "bwrap": self.bwrap})
        )
        m.get(f"{HP}/health").respond(200, json={"status": "ok"})
        m.post(f"{HP}/git/inspect").mock(
            side_effect=lambda r: httpx.Response(
                200,
                json={
                    **self.inspect,
                    "path": json.loads(r.content)["path"],
                    "top": json.loads(r.content)["path"],
                },
            )
        )
        m.post(f"{HP}/accounts").mock(side_effect=self._create_account)
        m.get(url__regex=rf"{HP}/accounts/status\?").mock(side_effect=self._account_status)
        m.post(f"{HP}/codex/usage").mock(side_effect=self._codex)
        m.post(f"{HP}/overflow-key").mock(side_effect=self._key_write)
        m.post(f"{HP}/overflow-key/remove").mock(side_effect=self._key_remove)
        m.get(f"{HP}/overflow-keys").mock(
            side_effect=lambda r: httpx.Response(200, json={"agents": sorted(self.key_files)})
        )
        m.post(f"{HP}/git/worktrees").mock(side_effect=self._create)
        m.post(f"{HP}/git/worktrees/diff").respond(
            200,
            json={
                "files": [{"path": "mathutils.py", "added": 4, "removed": 0}],
                "diff": "+def multiply",
                "truncated": False,
            },
        )
        m.post(f"{HP}/git/worktrees/commit").mock(side_effect=self._commit)
        m.post(f"{HP}/git/worktrees/remove").mock(side_effect=self._remove)
        m.post(f"{HP}/git/worktrees/attachments").mock(side_effect=self._attachments)
        # M4.5a: no packs installed unless a test says so (tests/test_packs.py)
        m.get(url__regex=rf"{HP}/packs(\?.*)?$").mock(
            side_effect=lambda r: httpx.Response(
                200,
                json={"packs": self.packs, "service_path": "/usr/bin:/bin", "store": "~/.switchboard/packs"},
            )
        )
        m.get(url__regex=rf"{HP}/git/worktrees\?").mock(
            side_effect=lambda r: httpx.Response(
                200,
                json={
                    "worktrees": [
                        {"job_id": j, "tip": w["tip"], "merged": w.get("merged", False), "bytes": 10}
                        for j, w in self.worktrees.items()
                        if j not in self.removed
                    ],
                    "bytes": 10,
                },
            )
        )

    def _create_account(self, r):
        b = json.loads(r.content)
        self.accounts.add((b["cli"], b["name"]))
        home = f"~/.switchboard/accounts/{b['cli']}/{b['name']}"
        env = "CLAUDE_CONFIG_DIR" if b["cli"] == "claude" else "CODEX_HOME"
        return httpx.Response(
            200, json={**b, "home": home, "login_command": f"{env}={home} {b['cli']} login"}
        )

    def _account_status(self, r):
        cli, name = r.url.params["cli"], r.url.params["name"]
        env_name = "CLAUDE_CONFIG_DIR" if cli == "claude" else "CODEX_HOME"
        env = {} if name == "default" else {env_name: f"/home/user/.switchboard/accounts/{cli}/{name}"}
        logged = (cli, name) not in self.logged_out and (name == "default" or (cli, name) in self.accounts)
        return httpx.Response(
            200,
            json={
                "cli": cli,
                "name": name,
                "installed": True,
                "logged_in": logged,
                "plan": self.plans.get((cli, name)) if logged else None,
                "home": "~/.claude" if name == "default" else f"~/.switchboard/accounts/{cli}/{name}",
                "login_command": f"{env_name}=… {cli} login",
                "env": env,
            },
        )

    def _codex(self, r):
        self.codex_calls.append(json.loads(r.content))
        return httpx.Response(200, json=self.codex)

    def _key_write(self, r):
        b = json.loads(r.content)
        self.key_files[b["agent"]] = b["key"]
        path = f"/home/user/.switchboard/overflow/{b['agent']}.key"
        return httpx.Response(200, json={"path": path, "abs_path": path})

    def _key_remove(self, r):
        removed = self.key_files.pop(json.loads(r.content)["agent"], None) is not None
        return httpx.Response(200, json={"removed": removed})

    def _create(self, r):
        b = json.loads(r.content)
        wt = {
            "path": f"/home/user/.switchboard/worktrees/{b['slug']}/job-{b['job_id']}",
            "branch": f"switchboard/job-{b['job_id']}",
            "base_sha": "a" * 40,
            "created": True,
            "tip": "a" * 40,
        }
        self.worktrees[b["job_id"]] = wt
        return httpx.Response(200, json=wt)

    def _commit(self, r):
        j = json.loads(r.content)["job_id"]
        self.committed.append(j)
        self.messages.append(json.loads(r.content)["message"])
        self.worktrees[j]["tip"] = "b" * 40
        return httpx.Response(
            200, json={"committed": True, "sha": "b" * 40, "branch": f"switchboard/job-{j}"}
        )

    def _attachments(self, r):
        b = json.loads(r.content)
        self.copied = getattr(self, "copied", []) + [b]
        return httpx.Response(200, json={"copied": len(b["files"]), "folder": ".switchboard/attachments"})

    def _remove(self, r):
        self.removed.append(json.loads(r.content)["job_id"])
        return httpx.Response(200, json={"removed": True})


@pytest.fixture
def fakes(mock_http, litellm):
    pc, host = FakePaperclip(), FakeHost()
    pc.install(mock_http)
    host.install(mock_http)
    return pc, host


async def step(job_id: int, times: int = 1):
    c = Paperclip()
    try:
        for _ in range(times):
            await jobs.advance(job_id, c)
    finally:
        await c.aclose()


async def add_project(client) -> int:
    r = await client.post("/projects", json={"path": REPO}, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def get(session, job_id: int) -> Job:
    session.expire_all()
    return await session.get(Job, job_id)


async def start(client, **kw) -> dict:
    pid = await add_project(client)
    body = {"prompt": "Add a function multiply(a, b) with tests", "project_id": pid, **kw}
    r = await client.post("/jobs", json=body, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()


async def test_level_1_plan_approve_edit_review_done(client, fakes, session):
    pc, host = fakes
    job = await start(client, agent="claude-code", autonomy=1)
    jid = job["id"]
    assert job["status"] == "queued" and job["agent_chain"] == ["claude-code"]
    await step(jid)
    j = await get(session, jid)
    assert j.status == "running" and j.phase == "read_only" and j.worktree_path.endswith(f"job-{jid}")
    plan_run = pc.runs[pc.last_run()]
    assert plan_run["scopeKind"] == "company"  # agent-level wake: no issue automations (ADR 0007)
    assert (
        plan_run["config"]["cwd"] == j.worktree_path
        and "--permission-mode" in plan_run["config"]["extraArgs"]
    )
    assert plan_run["config"]["extraArgs"][1] == "plan" and "only make a plan" in plan_run["instructions"]
    assert pc.wakes[-1]["body"]["forceFreshSession"] is True
    issue = next(iter(pc.issues.values()))
    assert issue["status"] == "in_progress" and issue["assigneeUserId"] == "local-board"  # never an agent
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")
    await step(jid)
    j = await get(session, jid)
    assert (j.status, j.gate) == ("needs_approval", "plan") and j.plan_text.startswith("Plan")
    ap = pc.approvals[j.paperclip_approval_id]
    assert (
        ap["type"] == "request_board_approval"
        and ap["payload"]["kind"] == "plan"
        and ap["issueIds"] == [issue["id"]]
    )
    assert issue["status"] == "in_review"
    r = await client.post(f"/jobs/{jid}/approve", json={"note": "Go"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "queued" and ap["status"] == "approved"
    await step(jid)
    j = await get(session, jid)
    assert j.status == "running" and j.phase == "edit"
    edit_run = pc.runs[pc.last_run()]
    assert (
        edit_run["config"]["extraArgs"][1] == "acceptEdits"
        and "The owner approved this plan" in edit_run["instructions"]
    )
    pc.finish(pc.last_run(), fixture="run_get_claude_edit")
    await step(jid)
    j = await get(session, jid)
    assert (j.status, j.gate) == ("needs_approval", "diff")
    d = await client.get(f"/jobs/{jid}/diff", headers=ADMIN)
    assert d.status_code == 200 and d.json()["files"][0]["path"] == "mathutils.py"
    r = await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "done"
    assert host.committed == [jid] and jid not in host.removed  # the branch has the work; worktree kept
    subject, _, body = host.messages[0].partition("\n\n")
    assert subject.startswith(f"Switchboard job {jid}: ") and len(subject) <= 72 and "multiply" in body
    assert issue["status"] == "done"
    # costs: one row per run, list price kept, $0 money on a subscription, linked to the job's request
    rows = (await session.scalars(select(Cost).where(Cost.source == "paperclip").order_by(Cost.id))).all()
    assert (
        len(rows) == 2 and all(float(c.cost_usd) == 0 for c in rows) and all(c.list_price_usd for c in rows)
    )
    assert {c.external_id for c in rows} == {f"paperclip-run:{w['run']}" for w in pc.wakes}
    assert rows[0].request_id == j.request_id
    req = await session.get(RequestRow, j.request_id)
    assert req.kind == "job" and req.target == "agent:claude-code" and req.autonomy == 1
    # traceability
    kinds = [
        e.kind
        for e in (
            await session.scalars(select(JobEvent).where(JobEvent.job_id == jid).order_by(JobEvent.id))
        ).all()
    ]
    assert kinds == [
        "created",
        "worktree",
        "run_started",
        "run_finished",
        "needs_approval",
        "approved",
        "run_started",
        "run_finished",
        "needs_approval",
        "approved",
        "committed",
        "done",
    ]
    # agent costs never count toward the chat daily cap
    assert await spent_today(session) == 0


async def test_reject_stops_and_removes_the_worktree(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="claude-code", autonomy=1))["id"]
    await step(jid)
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")
    await step(jid)
    r = await client.post(f"/jobs/{jid}/reject", json={"note": "Not like this"}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["status"] == "stopped" and "Not like this" in r.json()["error"]
    assert host.removed == [jid] and r.json()["worktree"] is None
    assert next(iter(pc.approvals.values()))["status"] == "rejected"
    assert next(iter(pc.issues.values()))["status"] == "cancelled"


async def test_stop_while_running_cancels_the_run(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="codex", autonomy=2))["id"]
    await step(jid)
    run = pc.last_run()
    assert pc.runs[run]["config"]["args"][:4] == ["exec", "--json", "-s", "workspace-write"]
    r = await client.post(f"/jobs/{jid}/stop", headers=ADMIN)
    assert r.json()["status"] == "stopped" and pc.cancelled == [run] and host.removed == [jid]
    # what the stopped run had used is still recorded (one row, keyed by the run)
    assert (
        await session.scalar(select(Cost.external_id).where(Cost.source == "paperclip"))
        == f"paperclip-run:{run}"
    )
    again = await client.post(f"/jobs/{jid}/stop", headers=ADMIN)  # stopping twice is fine
    assert again.status_code == 200


async def test_level_0_result_review_and_codex_cost_not_reported(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="codex", autonomy=0))["id"]
    await step(jid)
    assert pc.runs[pc.last_run()]["config"]["args"][2:4] == ["-s", "read-only"]
    pc.finish(pc.last_run(), fixture="run_get_codex-proc")
    await step(jid)
    j = await get(session, jid)
    assert (j.status, j.gate) == ("needs_approval", "result") and "multiply" in j.result_text
    assert j.cost_reported is False and float(j.list_price_usd) == 0
    r = await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
    assert r.json()["status"] == "done" and host.removed == [jid]  # nothing changed: worktree removed
    assert r.json()["cost_reported"] is False


async def test_fallback_before_the_first_run_only(client, fakes, session):
    pc, host = fakes
    host.installed = {"opencode"}
    pid = await add_project(client)
    r = await client.post(
        "/jobs",
        json={"prompt": "Fix the failing tests in this repo", "project_id": pid, "autonomy": 2},
        headers=ADMIN,
    )
    assert r.status_code == 201, r.text
    jid = r.json()["id"]
    assert r.json()["agent_chain"][0] == "claude-code"  # the routing rule's chain (code-heavy)
    await step(jid)
    j = await get(session, jid)
    assert j.agent == "opencode" and j.status == "running"
    fb = await session.scalar(select(JobEvent).where(JobEvent.job_id == jid, JobEvent.kind == "fallback"))
    assert {s["agent"] for s in fb.data["skipped"]} >= {"claude-code", "codex"}
    assert all(
        "not installed" in s["reason"] or "isn't set up" in s["reason"] or "Not verified" in s["reason"]
        for s in fb.data["skipped"]
    )


async def test_a_research_job_falls_back_to_a_runnable_agent(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    r = await client.post(
        "/jobs",
        json={
            "prompt": "/research compare three Python test runners and report",
            "project_id": pid,
            "autonomy": 0,
        },
        headers=ADMIN,
    )
    jid = r.json()["id"]
    assert r.json()["agent_chain"] == ["hermes", "gemini-cli", "claude-code"]
    await step(jid)
    j = await get(session, jid)
    assert j.agent == "claude-code" and j.status == "running" and j.phase == "read_only"


async def test_no_agent_available_fails_with_reasons(client, fakes, session):
    pc, host = fakes
    host.installed = set()
    jid = (await start(client, autonomy=2))["id"]
    await step(jid)
    j = await get(session, jid)
    assert j.status == "failed" and "No agent can take this job" in j.error and pc.wakes == []


async def test_level_3_needs_a_budget_and_is_never_run_without_a_sandbox(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    r = await client.post(
        "/jobs", json={"prompt": "x", "project_id": pid, "agent": "claude-code", "autonomy": 3}, headers=ADMIN
    )
    assert r.status_code == 400 and "budget" in r.json()["detail"]
    for agent in ("claude-code", "codex", "opencode"):
        r = await client.post(
            "/jobs",
            json={"prompt": "x", "project_id": pid, "agent": agent, "autonomy": 3, "budget_list_usd": 1},
            headers=ADMIN,
        )
        jid = r.json()["id"]
        await step(jid)
        j = await get(session, jid)
        assert j.status == "failed" and "Level 3" in j.error
    assert pc.wakes == []  # nothing ran


async def test_one_active_run_per_agent_the_rest_queue(client, fakes, session):
    pc, host = fakes
    a = (await start(client, agent="claude-code", autonomy=2))["id"]
    r = await client.post(
        "/jobs",
        json={
            "prompt": "Second task",
            "project_id": (await session.scalar(select(Project.id))),
            "agent": "claude-code",
            "autonomy": 2,
        },
        headers=ADMIN,
    )
    b = r.json()["id"]
    await step(a)
    await step(b)
    assert (await get(session, a)).status == "running" and (await get(session, b)).status == "queued"
    pc.finish(pc.last_run(), fixture="run_get_claude_edit")
    await step(a)
    await step(b)
    assert (await get(session, a)).status == "needs_approval" and (await get(session, b)).status == "running"


async def test_turn_cap_stops_a_runaway_run(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="opencode", autonomy=2))["id"]
    await step(jid)
    cap = load_agents().defaults.max_turns
    line = json.dumps({"type": "step_finish", "part": {"cost": 0, "tokens": {"input": 1, "output": 1}}})
    pc.logs[pc.last_run()] += (
        json.dumps({"ts": "t", "stream": "stdout", "chunk": (line + "\n") * (cap + 1)}) + "\n"
    )
    await step(jid)
    j = await get(session, jid)
    assert j.status == "stopped" and f"{cap} turns" in j.error and pc.cancelled


async def test_budget_cap_stops_between_runs(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="claude-code", autonomy=1, budget_list_usd=0.05))["id"]
    await step(jid)
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")  # $0.0627 list price > $0.05
    await step(jid)
    await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
    await step(jid)
    j = await get(session, jid)
    assert j.status == "stopped" and "budget" in j.error and len(pc.wakes) == 1


async def test_claude_stopping_itself_at_the_budget_is_a_stop(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="claude-code", autonomy=1, budget_list_usd=0.03))["id"]
    await step(jid)
    assert "--max-budget-usd" in pc.runs[pc.last_run()]["config"]["extraArgs"]
    pc.finish(pc.last_run(), status="failed", fixture="run_get_claude_plan")
    pc.runs[pc.last_run()]["error"] = (
        "Claude run failed: subtype=error_max_budget_usd: Reached maximum budget ($0.03)"
    )
    await step(jid)
    j = await get(session, jid)
    assert j.status == "stopped" and j.error == "Stopped at the job's budget ($0.03 list price)"
    assert float(j.list_price_usd) > 0.03 and host.removed == [jid]
    # Paperclip leaves the agent in status "error" after a failed run: the next job clears it and runs
    next(iter(pc.agents.values()))["status"] = "error"
    nxt = (
        await client.post(
            "/jobs",
            json={"prompt": "again", "project_id": j.project_id, "agent": "claude-code", "autonomy": 0},
            headers=ADMIN,
        )
    ).json()["id"]
    await step(nxt)
    assert (await get(session, nxt)).status == "running" and pc.cleared == 1


async def test_an_approval_decided_in_paperclip_counts(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="claude-code", autonomy=1))["id"]
    await step(jid)
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")
    await step(jid)
    j = await get(session, jid)
    pc.approvals[j.paperclip_approval_id].update(status="approved", decisionNote="from Paperclip")
    await step(jid)
    j = await get(session, jid)
    assert j.status == "queued" and j.run_index == 1
    ev = await session.scalar(select(JobEvent).where(JobEvent.job_id == jid, JobEvent.kind == "approved"))
    assert ev.data["by"] == "paperclip" and ev.data["note"] == "from Paperclip"


async def test_a_failed_run_fails_the_job_and_removes_the_worktree(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="codex", autonomy=2))["id"]
    await step(jid)
    pc.finish(pc.last_run(), status="failed")
    pc.runs[pc.last_run()]["error"] = "codex exited with code 1"
    await step(jid)
    j = await get(session, jid)
    assert j.status == "failed" and "exited" in j.error and host.removed == [jid]
    assert next(iter(pc.issues.values()))["status"] == "blocked"


async def test_cost_ingest_is_idempotent(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="claude-code", autonomy=0))["id"]
    await step(jid)
    pc.finish(pc.last_run(), fixture="run_get_claude_plan")
    await step(jid)
    j = await get(session, jid)
    await jobs._record(session, j, load_agents().agent("claude-code"), pc.runs[pc.last_run()], None)
    await session.commit()
    n = await session.scalar(select(func.count()).select_from(Cost).where(Cost.source == "paperclip"))
    assert n == 1


async def test_job_refusals(client, fakes, session):
    pc, host = fakes
    pid = await add_project(client)
    secret = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0" * 2  # gitleaks:allow
    r = await client.post("/jobs", json={"prompt": f"use {secret}", "project_id": pid}, headers=ADMIN)
    assert r.status_code == 400 and "secret" in r.json()["detail"]
    r = await client.post("/jobs", json={"prompt": "x", "project_id": 999}, headers=ADMIN)
    assert r.status_code == 400 and "allowlist" in r.json()["detail"]
    r = await client.post("/jobs", json={"prompt": "x", "project_id": pid, "agent": "nope"}, headers=ADMIN)
    assert r.status_code == 400
    assert (await client.post("/jobs", json={"prompt": "x", "project_id": pid})).status_code == 401
    private = RequestRow(kind="chat", private=True)
    session.add(private)
    await session.commit()
    r = await client.post(
        "/jobs", json={"prompt": "x", "project_id": pid, "from_request_id": private.id}, headers=ADMIN
    )
    assert r.status_code == 400 and "private" in r.json()["detail"].lower()


async def test_projects_allowlist(client, fakes, session):
    pc, host = fakes
    host.inspect = {**host.inspect, "is_self": True}
    r = await client.post("/projects", json={"path": "/home/user/switchboard"}, headers=ADMIN)
    assert r.status_code == 403 and "Switchboard repository itself" in r.json()["detail"]
    host.inspect = {**host.inspect, "is_self": False, "is_repo": False}
    r = await client.post("/projects", json={"path": "/home/user/notes"}, headers=ADMIN)
    assert r.status_code == 400 and "isn't a git repository" in r.json()["detail"]
    host.inspect = {**host.inspect, "is_repo": True}
    pid = await add_project(client)
    again = await client.post("/projects", json={"path": REPO}, headers=ADMIN)
    assert again.json()["id"] == pid  # same folder, same project
    listed = (await client.get("/projects", headers=ADMIN)).json()["projects"]
    assert [p["path"] for p in listed] == [REPO] and listed[0]["slug"] == "playground"
    jid = (
        await client.post("/jobs", json={"prompt": "x", "project_id": pid, "agent": "codex"}, headers=ADMIN)
    ).json()["id"]
    assert (await client.delete(f"/projects/{pid}", headers=ADMIN)).status_code == 409  # an active job
    await client.post(f"/jobs/{jid}/stop", headers=ADMIN)
    assert (await client.delete(f"/projects/{pid}", headers=ADMIN)).json() == {"removed": True}
    assert (await client.get("/projects", headers=ADMIN)).json()["projects"] == []
    r = await client.post("/jobs", json={"prompt": "x", "project_id": pid}, headers=ADMIN)
    assert r.status_code == 400  # off the allowlist


async def test_retention_removes_merged_worktrees_and_keeps_the_rest(client, fakes, session):
    pc, host = fakes
    ids = []
    for _ in range(3):
        jid = (
            (await start(client, agent="claude-code", autonomy=2))["id"]
            if not ids
            else (
                await client.post(
                    "/jobs",
                    json={
                        "prompt": "again",
                        "project_id": (await session.scalar(select(Project.id))),
                        "agent": "claude-code",
                        "autonomy": 2,
                    },
                    headers=ADMIN,
                )
            ).json()["id"]
        )
        await step(jid)
        pc.finish(pc.last_run(), fixture="run_get_claude_edit")
        await step(jid)
        await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
        ids.append(jid)
    assert host.removed == []
    host.worktrees[ids[0]]["merged"] = True  # its branch was merged (and has a commit beyond its base)
    pid = await session.scalar(select(Project.id))
    r = await client.post(f"/projects/{pid}/cleanup", headers=ADMIN)
    assert r.status_code == 200 and ids[0] in host.removed and ids[2] not in host.removed


async def test_agents_api(client, fakes, session):
    pc, host = fakes
    host.installed = {"claude", "codex"}
    host.bwrap = False
    r = await client.get("/agents", headers=ADMIN)
    rows = {a["id"]: a for a in r.json()["agents"]}
    assert rows["claude-code"]["installed"] and rows["claude-code"]["levels"]["1"] is None
    assert (
        "sandbox" in rows["claude-code"]["levels"]["3"] and "ADR 0010" in rows["claude-code"]["levels"]["3"]
    )
    assert "not installed" in rows["opencode"]["levels"]["0"]
    assert rows["hermes"]["runnable"] is False and rows["hermes"]["installed"] is False
    assert r.json()["bwrap"] is False


async def test_events_stream_snapshots_logs_and_end(client, fakes, session):
    pc, host = fakes
    jid = (await start(client, agent="codex", autonomy=0))["id"]
    await step(jid)
    pc.finish(pc.last_run(), fixture="run_get_codex-proc")
    await step(jid)
    await client.post(f"/jobs/{jid}/approve", json={}, headers=ADMIN)
    async with client.stream("GET", f"/jobs/{jid}/events", headers=ADMIN) as r:
        body = (await r.aread()).decode()
    events = re.findall(r"^event: (\w+)$", body, re.M)
    assert events[0] == "job" and events[-1] == "end"


# --- M2.5: attachments in jobs ---------------------------------------------------------------------------
async def test_job_gets_its_files_in_a_git_ignored_folder(client, fakes, session, data_dir):
    from urllib.parse import quote

    from tests.attachments_util import png

    pc, host = fakes
    up = await client.post(
        "/attachments",
        content=png(),
        headers={**ADMIN, "Content-Type": "application/octet-stream", "X-Filename": quote("design.png")},
    )
    att = up.json()
    job = await start(client, agent="claude-code", autonomy=1, attachment_ids=[att["id"]])
    jid = job["id"]
    j = await get(session, jid)
    assert ".switchboard/attachments/" in j.prompt and "design.png" in j.prompt and "don't commit" in j.prompt
    assert (data_dir / "attachments" / "jobs" / str(jid)).is_dir()
    await step(jid)
    assert host.copied[-1]["job_id"] == jid and host.copied[-1]["files"][0]["name"] == "design.png"
    detail = (await client.get(f"/jobs/{jid}", headers=ADMIN)).json()
    assert detail["attachments"][0]["name"] == "design.png"
    assert "attachments_copied" in [e["kind"] for e in detail["events"]]


async def test_job_refuses_private_or_secret_files(client, fakes, session):
    from urllib.parse import quote

    key = "sk-proj-" + "Q1w2E3r4" * 6  # gitleaks:allow
    up = await client.post(
        "/attachments",
        content=f"token={key}".encode(),
        headers={**ADMIN, "Content-Type": "application/octet-stream", "X-Filename": quote("env.txt")},
    )
    pid = await add_project(client)
    r = await client.post(
        "/jobs",
        json={"prompt": "use this", "project_id": pid, "attachment_ids": [up.json()["id"]]},
        headers=ADMIN,
    )
    assert r.status_code == 400 and "contains a secret" in r.json()["detail"]
