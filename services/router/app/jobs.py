"""Agent jobs (M4a, ADR 0007): Switchboard drives the phases, Paperclip runs the agents.

A job: one task, one allowlisted project, one agent (chosen from a fallback chain before its first run
starts, never switched mid-job), one autonomy level (config/agents.yaml `levels`).

    queued ─start→ running ─run ends→ running (next run) | needs_approval (plan | diff | result)
    needs_approval ─approve→ running (after the plan) | done      ─reject→ stopped
    any active state ─stop→ stopped;  a run that fails or a cap that trips → failed / stopped

Each run: the agent's Paperclip config is set for that run (worktree, the level's flags, a clean
environment, the task), then one agent-level wake. One active run per agent (`max_active_per_agent`), the
rest wait in the queue. The job loop (`loop()`) advances active jobs; everything is persisted, so a restart
picks up where it was. Every change is appended to `job_events` (traceability, SPEC §13.5).

Worktrees come from hostprobe (ADR 0008): `switchboard/job-<id>` from the project's HEAD, outside the repo.
A job that is rejected, fails or is stopped loses its worktree (the branch stays); done jobs keep theirs
until the branch is merged or more than `keep_per_project` are kept.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import urllib.parse
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import db, hostprobe_client
from app.agents import AgentDef, AgentRegistry, Level, build_run, load_agents
from app.config import get_settings
from app.job_output import TurnCounter, outcome
from app.models import Cost, Job, JobEvent, Project, SystemMeta
from app.paperclip import TERMINAL_RUN, Paperclip, PaperclipError

log = logging.getLogger("app.jobs")

ACTIVE = ("queued", "running", "needs_approval")
TERMINAL = ("done", "failed", "stopped")
META_KEY = "paperclip"
COMPANY_NAME = "Switchboard"
LOOP_INTERVAL_S = 2.0
READY_WAIT_S = 90
LOG_PAGE_BYTES = 256 * 1024
ISSUE_STATUS = {
    "queued": "todo",
    "running": "in_progress",
    "needs_approval": "in_review",
    "done": "done",
    "failed": "blocked",
    "stopped": "cancelled",
}


class JobError(Exception):
    """A plain-language refusal for the API (status code + one sentence)."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now() -> datetime:
    return datetime.now(UTC)


def day_start() -> datetime:
    t = now()
    return t.replace(hour=0, minute=0, second=0, microsecond=0)


# --- small persistence helpers ------------------------------------------------------------------
async def event(session: AsyncSession, job: Job, kind: str, /, **data: Any) -> None:
    session.add(JobEvent(job_id=job.id, kind=kind, data=data))


async def meta(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(SystemMeta, META_KEY)
    try:
        return json.loads(row.value) if row else {}
    except ValueError:
        return {}


async def save_meta(session: AsyncSession, data: dict[str, Any]) -> None:
    row = await session.get(SystemMeta, META_KEY)
    if row is None:
        session.add(SystemMeta(key=META_KEY, value=json.dumps(data)))
    else:
        row.value = json.dumps(data)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50]
    return s or "project"


# --- availability ---------------------------------------------------------------------------------
async def host_facts() -> tuple[dict[str, Any], bool | None]:
    """(hostprobe's CLI rows, whether bwrap exists). Never raises: unknown when hostprobe is down."""
    ok, data, _ = await hostprobe_client.probe("/cli", timeout=30)
    clis = (data or {}).get("clis") or {} if ok else {}
    ok_hw, hw, _ = await hostprobe_client.probe("/hw", timeout=15)
    bwrap = (hw or {}).get("bwrap") if ok_hw and hw else None
    return clis, bwrap


async def agent_spent_today(session: AsyncSession, agent_id: str) -> float:
    total = await session.scalar(
        select(func.coalesce(func.sum(Cost.list_price_usd), 0))
        .join(Job, Job.request_id == Cost.request_id)
        .where(Cost.source == "paperclip", Cost.created_at >= day_start(), Job.agent == agent_id)
    )
    return float(total or 0)


def unavailable(
    reg: AgentRegistry, agent: AgentDef, level: Level, clis: dict[str, Any], bwrap: bool | None
) -> str | None:
    """Why `agent` can't take a job at `level` now (before any run starts), or None."""
    why = agent.level_unavailable(level)
    if why:
        return why
    row = clis.get(agent.cli)
    if row is None:
        return f"Can't check whether {agent.label} is installed (hostprobe isn't answering)"
    if row.get("windows_only") or not row.get("installed"):
        return f"{agent.label} is not installed in WSL"
    if row.get("logged_in") is False:
        return f"{agent.label} is not logged in: run `{agent.cli}` in a terminal and log in"
    if level.needs_sandbox and bwrap is not True:
        return "Level 3 needs the bwrap sandbox: install it with `sudo apt install bubblewrap`, then retry"
    return None


# --- Paperclip objects ------------------------------------------------------------------------------
async def ensure_company(session: AsyncSession, pc: Paperclip) -> str:
    m = await meta(session)
    if m.get("company_id"):
        return str(m["company_id"])
    found = next((c for c in await pc.companies() if c.get("name") == COMPANY_NAME), None)
    company = found or await pc.create_company(COMPANY_NAME, "Agent jobs started from Switchboard (ADR 0007)")
    m["company_id"] = company["id"]
    await save_meta(session, m)
    await session.commit()
    return str(company["id"])


async def ensure_agent(
    session: AsyncSession,
    pc: Paperclip,
    company_id: str,
    agent: AgentDef,
    adapter_type: str,
    cfg: dict[str, Any],
    instructions: str,
) -> str:
    """The Paperclip agent for a registry entry, configured for the next run and ready to run."""
    m = await meta(session)
    agents = m.setdefault("agents", {})
    pid = agents.get(agent.id)
    current = await pc.agent(pid) if pid else None
    if current is None:
        found = next(
            (
                a
                for a in await pc.agents(company_id)
                if (a.get("metadata") or {}).get("switchboardAgent") == agent.id
                and a.get("status") != "terminated"
            ),
            None,
        )
        if found:
            current = found
        else:
            current = await pc.create_agent(
                company_id,
                name=f"Switchboard {agent.label}",
                adapter_type=adapter_type,
                adapter_config=cfg,
                instructions=instructions,
                metadata={"managedBy": "switchboard", "switchboardAgent": agent.id},
            )
        agents[agent.id] = current["id"]
        await save_meta(session, m)
        await session.commit()
    pid = str(current["id"])
    await pc.set_agent_config(pid, cfg)
    await pc.set_instructions(pid, instructions)
    await wait_ready(pc, pid, agent)
    return pid


async def wait_ready(pc: Paperclip, pid: str, agent: AgentDef) -> None:
    """A new or reconfigured Paperclip agent is `paused`/`verifying` until its check passes (docs/m4a.md)."""
    deadline = time.monotonic() + READY_WAIT_S
    retried_at: float | None = None
    while True:
        a = await pc.agent(pid)
        if a is None:
            raise JobError(502, f"Paperclip lost the {agent.label} agent")
        state = a.get("lifecycleState")
        if state == "ready" and a.get("status") not in ("paused", "terminated", "pending_approval"):
            return
        if state not in ("verifying", "preparing"):
            if retried_at is None:
                await pc.retry_lifecycle(pid)
                retried_at = time.monotonic()
            elif time.monotonic() - retried_at > 10:
                msg = a.get("lifecycleError") or "its setup check did not pass"
                raise JobError(502, f"Paperclip can't run {agent.label}: {msg} (run scripts/doctor.sh)")
        if time.monotonic() > deadline:
            raise JobError(504, f"Paperclip didn't get {agent.label} ready within {READY_WAIT_S} s")
        await asyncio.sleep(2)


# --- creating a job ---------------------------------------------------------------------------------
async def create(
    session: AsyncSession,
    *,
    prompt: str,
    project: Project,
    chain: list[str],
    autonomy: int,
    budget_list_usd: float | None,
    request_id: int | None,
    title: str | None = None,
) -> Job:
    reg = load_agents()
    level = reg.levels.get(autonomy)
    if level is None:
        raise JobError(400, "autonomy must be 0, 1, 2 or 3")
    if level.needs_budget and budget_list_usd is None:
        raise JobError(400, "Level 3 needs a budget for this job (budget_list_usd)")
    known = [a for a in chain if a in reg.agents]
    if not known:
        raise JobError(400, "none of these agents is in config/agents.yaml")
    budget = budget_list_usd if budget_list_usd is not None else reg.defaults.per_job_list_usd
    if budget <= 0:
        raise JobError(400, "the budget must be more than $0")
    job = Job(
        request_id=request_id,
        project_id=project.id,
        title=(title or prompt.strip().splitlines()[0])[:200],
        prompt=prompt,
        agent=known[0],
        agent_chain=known,
        autonomy=autonomy,
        status="queued",
        budget_list_usd=budget,
        cost_reported=reg.agents[known[0]].cost == "reported",
        tag=get_settings().router_request_tag or None,
    )
    session.add(job)
    await session.flush()
    await event(
        session, job, "created", agent_chain=known, autonomy=autonomy, project=project.path, budget=budget
    )
    await session.commit()
    return job


# --- the state machine ------------------------------------------------------------------------------
_locks: dict[int, asyncio.Lock] = {}
_counters: dict[str, TurnCounter] = {}  # run id -> stdout read so far (rebuilt from offset 0 after a restart)


def _lock(job_id: int) -> asyncio.Lock:
    return _locks.setdefault(job_id, asyncio.Lock())


async def advance(job_id: int, pc: Paperclip) -> None:
    """One step for one job (the loop calls this; also after approve/reject). Never raises."""
    lock = _lock(job_id)
    if lock.locked():
        return
    async with lock:
        try:
            async with db.sessionmaker()() as session:
                job = await session.get(Job, job_id)
                if job is None or job.status in TERMINAL:
                    _locks.pop(job_id, None)
                    return
                if job.status == "queued":
                    await _maybe_start(session, pc, job)
                elif job.status == "running":
                    await _follow_run(session, pc, job)
                elif job.status == "needs_approval":
                    await _check_approval(session, pc, job)
        except Exception:  # noqa: BLE001 - the loop must survive anything; the job keeps its state
            log.exception("job %s: step failed", job_id)


async def _busy(session: AsyncSession, agent: str, job_id: int) -> bool:
    reg = load_agents()
    n = await session.scalar(
        select(func.count())
        .select_from(Job)
        .where(Job.agent == agent, Job.status == "running", Job.id != job_id)
    )
    return int(n or 0) >= reg.defaults.max_active_per_agent


async def _maybe_start(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    reg = load_agents()
    level = reg.levels[job.autonomy]
    project = await session.get(Project, job.project_id)
    assert project is not None
    if job.run_index == 0 and not job.started_at:
        # Choose the agent (fallback only before the first run starts).
        clis, bwrap = await host_facts()
        reasons = []
        chosen = None
        for aid in job.agent_chain:
            agent = reg.agents.get(aid)
            if agent is None:
                continue
            why = unavailable(reg, agent, level, clis, bwrap)
            if why is None:
                spent = await agent_spent_today(session, aid)
                if spent >= reg.defaults.per_agent_daily_list_usd:
                    cap = reg.defaults.per_agent_daily_list_usd
                    why = f"{agent.label} reached today's budget (${spent:.2f} of ${cap:.2f} list price)"
            if why is None:
                chosen = agent
                break
            reasons.append({"agent": aid, "reason": why})
        if reasons:
            await event(session, job, "fallback", skipped=reasons, chosen=chosen.id if chosen else None)
        if chosen is None:
            await _finish(
                session,
                pc,
                job,
                "failed",
                "No agent can take this job: " + "; ".join(r["reason"] for r in reasons),
            )
            return
        if chosen.id != job.agent:
            job.agent = chosen.id
            job.cost_reported = chosen.cost == "reported"
        await session.commit()
    if await _busy(session, job.agent, job.id):
        return  # waits in the queue
    agent = reg.agents[job.agent]
    company = await ensure_company(session, pc)
    # The job's Paperclip issue: owned by you (the board user), never by an agent (ADR 0007).
    if not job.paperclip_issue_id:
        issue = await pc.create_issue(
            company,
            title=f"Switchboard job {job.id}: {job.title}"[:240],
            description=(
                f"Project: {project.path}\nAgent: {agent.label}\nAutonomy: {job.autonomy}\n\n{job.prompt}"
            ),
            assignee_user_id=None,
            idempotency_key=f"switchboard-job-{job.id}",
        )
        job.paperclip_issue_id = issue["id"]
        m = await meta(session)
        if issue.get("createdByUserId") and not m.get("board_user_id"):
            m["board_user_id"] = issue["createdByUserId"]
            await save_meta(session, m)
        await session.commit()
    # The worktree (hostprobe, ADR 0008).
    if not job.worktree_path:
        status, wt = await hostprobe_client.call(
            "POST", "/git/worktrees", {"project": project.path, "slug": project.slug, "job_id": job.id}
        )
        if status != 200:
            await _finish(
                session, pc, job, "failed", f"Couldn't create the job's worktree: {wt.get('error')}"
            )
            return
        job.worktree_path, job.branch, job.base_sha = wt["path"], wt["branch"], wt["base_sha"]
        await event(session, job, "worktree", path=wt["path"], branch=wt["branch"], base=wt["base_sha"])
        await session.commit()
    await _start_run(session, pc, job, company)


def _task(job: Job, kind: str) -> str:
    if kind == "read_only":
        return (
            f"{job.prompt}\n\nFor now, only make a plan: read what you need, change nothing, and end "
            "with the plan as a short numbered list."
            if load_agents().levels[job.autonomy].approve_plan
            else f"{job.prompt}\n\nDon't change any files: answer with a report."
        )
    plan = f"\n\nThe owner approved this plan:\n\n{job.plan_text}" if job.plan_text else ""
    return (
        f"{job.prompt}{plan}\n\nWork only in this folder. Run the project's tests if there are any. Don't "
        "commit, don't push. End with a short summary of what you changed and the test result."
    )


async def _start_run(session: AsyncSession, pc: Paperclip, job: Job, company: str) -> None:
    reg = load_agents()
    level = reg.levels[job.autonomy]
    kind = level.runs[job.run_index]
    agent = reg.agents[job.agent]
    left = float(job.budget_list_usd) - float(job.list_price_usd or 0)
    if left <= 0:
        await _finish(session, pc, job, "stopped", "The job's budget is used up")
        return
    spec = build_run(
        reg, agent, kind, worktree=job.worktree_path or "", task=_task(job, kind), budget_left_usd=left
    )
    try:
        pid = await ensure_agent(
            session, pc, company, agent, spec.adapter_type, spec.adapter_config, spec.instructions
        )
    except (JobError, PaperclipError) as e:
        if (
            job.run_index == 0
            and not job.started_at
            and len(job.agent_chain) > job.agent_chain.index(job.agent) + 1
        ):
            # Before the first run only: try the next agent in the chain.
            nxt = job.agent_chain[job.agent_chain.index(job.agent) + 1]
            await event(
                session, job, "fallback", skipped=[{"agent": job.agent, "reason": str(e)}], chosen=nxt
            )
            job.agent_chain = [
                a for a in job.agent_chain if a != job.agent
            ]  # never chosen again for this job
            job.agent = nxt
            job.cost_reported = reg.agents[nxt].cost == "reported"
            await session.commit()
            return
        await _finish(session, pc, job, "failed", str(e))
        return
    run = await pc.wake(
        pid, reason="switchboard_job", idempotency_key=f"switchboard-job-{job.id}-run-{job.run_index}"
    )
    if run.get("status") == "skipped":  # a retried start: the run already exists
        run_id = run.get("executionRunId") or job.current_run_id
    else:
        run_id = run["id"]
    job.paperclip_agent_id = pid
    job.current_run_id = run_id
    job.log_offset = 0
    job.phase = kind
    job.gate = None
    job.status = "running"
    job.started_at = job.started_at or now()
    await event(session, job, "run_started", run=run_id, kind=kind, agent=agent.id, autonomy=job.autonomy)
    await session.commit()
    await _issue(pc, session, job)


async def _issue(pc: Paperclip, session: AsyncSession, job: Job) -> None:
    """Mirror the job's status on its Paperclip issue (best effort: never blocks the job)."""
    if not job.paperclip_issue_id:
        return
    try:
        status = ISSUE_STATUS[job.status]
        if status == "in_progress":
            m = await meta(session)
            board = m.get("board_user_id")
            if board:  # in_progress needs an owner: the board user (never an agent)
                await pc.update_issue(job.paperclip_issue_id, status=status, assigneeUserId=board)
            return
        await pc.set_issue_status(job.paperclip_issue_id, status)
    except PaperclipError as e:
        log.warning("job %s: issue status not mirrored: %s", job.id, e)


async def read_new_output(pc: Paperclip, job: Job, agent: AgentDef) -> list[dict[str, Any]]:
    """Read the current run's log from `job.log_offset` (resumable), feed the turn counter, return the new
    lines."""
    run_id = job.current_run_id
    if not run_id:
        return []
    counter = _counters.get(run_id)
    if counter is None:  # first read, or after a restart: rebuild from the start of the log
        counter = _counters[run_id] = TurnCounter(agent.permissions or "")
        job.log_offset = 0
    out: list[dict[str, Any]] = []
    for _ in range(40):  # bounded per step
        page = await pc.run_log(run_id, offset=int(job.log_offset or 0), limit_bytes=LOG_PAGE_BYTES)
        if not page.lines:
            break
        for line in page.lines:
            if line.get("stream") == "stdout":
                counter.feed(str(line.get("chunk") or ""))
        out.extend(page.lines)
        job.log_offset = page.next_offset
    return out


async def _follow_run(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    reg = load_agents()
    agent = reg.agents[job.agent]
    run = await pc.run(job.current_run_id) if job.current_run_id else None
    if run is None:
        await _finish(session, pc, job, "failed", "Paperclip lost the run")
        return
    await read_new_output(pc, job, agent)
    counter = _counters.get(job.current_run_id or "")
    status = run.get("status")
    if status not in TERMINAL_RUN:
        # Caps while it runs: turns (every agent), list price (agents that report it as they go), run time.
        listed = float(job.list_price_usd or 0) + (counter.list_price_usd if counter else 0.0)
        started = run.get("startedAt")
        overdue = False
        if started:
            t0 = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            overdue = now() - t0 > timedelta(
                seconds=reg.defaults.run_timeout_s + reg.defaults.run_grace_s + 60
            )
        reason = None
        if await run_seconds(session, job, started) > reg.defaults.job_timeout_s:
            reason = f"Stopped: the job's runs took longer than {reg.defaults.job_timeout_s} s in total"
        elif counter is not None and counter.turns > reg.defaults.max_turns:
            reason = f"Stopped after {reg.defaults.max_turns} turns (the cap in config/agents.yaml)"
        elif listed > float(job.budget_list_usd):
            reason = f"Stopped at the job's budget (${float(job.budget_list_usd):.2f} list price)"
        elif overdue:
            reason = f"Stopped: the run took longer than {reg.defaults.run_timeout_s} s"
        if reason:
            await pc.cancel_run(job.current_run_id or "")
            await _record(session, job, agent, run, counter)
            await _finish(session, pc, job, "stopped", reason)
            return
        await session.commit()
        return
    if counter is not None:
        counter.finish()
    out = await _record(session, job, agent, run, counter)
    _counters.pop(job.current_run_id or "", None)
    if status != "succeeded":
        what = {"cancelled": "stopped", "timed_out": "failed"}.get(status, "failed")
        msg = run.get("error") or f"The run ended: {status}"
        await _finish(session, pc, job, what, str(msg)[:500])
        return
    level = reg.levels[job.autonomy]
    kind = level.runs[job.run_index]
    if kind == "read_only" and level.approve_plan:
        job.plan_text = out.text
        await _gate(session, pc, job, "plan", out.text)
        return
    job.result_text = out.text
    if job.run_index + 1 < len(level.runs):
        job.run_index += 1
        job.status = "queued"  # next run (waits if the agent is busy)
        await session.commit()
        return
    await _gate(session, pc, job, level.review, out.text)


async def run_seconds(session: AsyncSession, job: Job, current_started: Any) -> float:
    """Time spent running (all finished runs plus the current one); waiting for you doesn't count."""
    total = 0.0
    for data in (
        await session.scalars(
            select(JobEvent.data).where(JobEvent.job_id == job.id, JobEvent.kind == "run_finished")
        )
    ).all():
        try:
            t0 = datetime.fromisoformat(str(data.get("started")).replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(str(data.get("finished")).replace("Z", "+00:00"))
            total += max(0.0, (t1 - t0).total_seconds())
        except (TypeError, ValueError):
            continue
    if current_started:
        t0 = datetime.fromisoformat(str(current_started).replace("Z", "+00:00"))
        total += max(0.0, (now() - t0).total_seconds())
    return total


async def _record(
    session: AsyncSession, job: Job, agent: AgentDef, run: dict[str, Any], counter: TurnCounter | None
):
    """Write the run's cost (idempotent per run) and add it to the job's totals."""
    out = outcome(agent, run, counter)
    ext = f"paperclip-run:{run.get('id')}"
    exists = await session.scalar(select(Cost.id).where(Cost.external_id == ext))
    if exists is None:
        await session.execute(
            insert(Cost)
            .values(
                request_id=job.request_id,
                source="paperclip",
                provider=out.provider,
                model=out.model,
                tokens_in=out.tokens_in,
                tokens_out=out.tokens_out,
                cost_usd=out.cost_usd,
                list_price_usd=out.list_price_usd,
                external_id=ext,
                tag=job.tag,
                created_at=now(),
            )
            .on_conflict_do_nothing(index_elements=["external_id"])
        )
        job.list_price_usd = float(job.list_price_usd or 0) + float(out.list_price_usd or 0)
        job.cost_usd = float(job.cost_usd or 0) + out.cost_usd
        if out.list_price_usd is None:
            job.cost_reported = False
        job.turns = (job.turns or 0) + out.turns
        await event(
            session,
            job,
            "run_finished",
            run=run.get("id"),
            status=run.get("status"),
            turns=out.turns,
            tokens_in=out.tokens_in,
            tokens_out=out.tokens_out,
            list_price_usd=out.list_price_usd,
            cost_usd=out.cost_usd,
            denied=list(out.denied),
            started=run.get("startedAt"),
            finished=run.get("finishedAt"),
        )
    return out


async def _gate(session: AsyncSession, pc: Paperclip, job: Job, gate: str, text: str) -> None:
    """Stop for the owner: a Paperclip approval linked to the job's issue (ADR 0007)."""
    company = (await meta(session)).get("company_id")
    title = {"plan": "Approve the plan", "diff": "Review the changes", "result": "Review the result"}[gate]
    approval_id = None
    try:
        if company and job.paperclip_issue_id:
            ap = await pc.create_approval(
                company,
                issue_id=job.paperclip_issue_id,
                payload={
                    "title": f"{title} for Switchboard job {job.id}",
                    "kind": gate,
                    "switchboardJobId": job.id,
                    "summary": text[:4000],
                },
            )
            approval_id = ap["id"]
            await pc.comment(job.paperclip_issue_id, f"**{title}** ({job.phase} run):\n\n{text[:20000]}")
    except PaperclipError as e:
        log.warning("job %s: approval not created in Paperclip: %s", job.id, e)
    job.status = "needs_approval"
    job.gate = gate
    job.current_run_id = None
    job.paperclip_approval_id = approval_id
    await event(session, job, "needs_approval", gate=gate, approval=approval_id)
    await session.commit()
    await _issue(pc, session, job)


async def _check_approval(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    """An approval decided in Paperclip's own UI counts too."""
    if not job.paperclip_approval_id:
        return
    ap = await pc.approval(job.paperclip_approval_id)
    st = (ap or {}).get("status")
    if st in ("approved", "rejected"):
        await decide(session, pc, job, st == "approved", ap.get("decisionNote"), by="paperclip", mirror=False)


async def decide(
    session: AsyncSession,
    pc: Paperclip,
    job: Job,
    approve: bool,
    note: str | None,
    *,
    by: str,
    mirror: bool = True,
) -> None:
    if job.status != "needs_approval" or not job.gate:
        raise JobError(409, f"Job {job.id} isn't waiting for approval (it is {job.status})")
    gate = job.gate
    if mirror and job.paperclip_approval_id:
        try:
            await pc.decide(job.paperclip_approval_id, approve, note)
        except PaperclipError as e:
            log.warning("job %s: decision not mirrored to Paperclip: %s", job.id, e)
    await event(session, job, "approved" if approve else "rejected", gate=gate, note=note, by=by)
    if not approve:
        await _finish(session, pc, job, "stopped", f"You rejected the {gate}" + (f": {note}" if note else ""))
        return
    reg = load_agents()
    level = reg.levels[job.autonomy]
    if gate == "plan":
        job.run_index += 1
        job.gate = None
        job.status = "queued"  # the edit run starts when the agent is free
        await session.commit()
        return
    if gate == "diff":
        project = await session.get(Project, job.project_id)
        assert project is not None
        status, res = await hostprobe_client.call(
            "POST",
            "/git/worktrees/commit",
            {
                "project": project.path,
                "slug": project.slug,
                "job_id": job.id,
                "message": f"Switchboard job {job.id}: {job.title}"[:300],
            },
        )
        if status != 200:
            job.error = f"Approved, but committing the changes failed: {res.get('error')}"
            await event(session, job, "commit_failed", error=res.get("error"))
            await session.commit()
            raise JobError(502, job.error)
        await event(
            session,
            job,
            "committed",
            sha=res.get("sha"),
            branch=res.get("branch"),
            committed=res.get("committed"),
        )
    await _finish(session, pc, job, "done", None, keep_worktree=gate == "diff" and level.review == "diff")


async def stop(session: AsyncSession, pc: Paperclip, job: Job, by: str = "you") -> None:
    if job.status in TERMINAL:
        return
    if job.current_run_id:
        await pc.cancel_run(job.current_run_id)
    if job.paperclip_approval_id and job.status == "needs_approval":
        try:
            await pc.decide(job.paperclip_approval_id, False, "Stopped in Switchboard")
        except PaperclipError:
            pass
    await event(session, job, "stop_requested", by=by)
    await _finish(session, pc, job, "stopped", f"Stopped by {by}")


async def _finish(
    session: AsyncSession,
    pc: Paperclip,
    job: Job,
    status: str,
    error: str | None,
    keep_worktree: bool = False,
) -> None:
    job.status = status
    job.error = error
    job.finished_at = now()
    job.current_run_id = None
    if status != "done":
        job.gate = None
    await event(session, job, status, error=error)
    await session.commit()
    if not keep_worktree:
        await remove_worktree(session, job)
    await _issue(pc, session, job)
    if job.paperclip_issue_id and error:
        try:
            await pc.comment(job.paperclip_issue_id, f"Job {status}: {error}")
        except PaperclipError:
            pass


async def remove_worktree(session: AsyncSession, job: Job) -> None:
    if not job.worktree_path or job.worktree_removed:
        return
    project = await session.get(Project, job.project_id)
    if project is None:
        return
    status, res = await hostprobe_client.call(
        "POST", "/git/worktrees/remove", {"project": project.path, "slug": project.slug, "job_id": job.id}
    )
    if status == 200:
        job.worktree_removed = True
        await event(session, job, "worktree_removed", branch=job.branch)
        await session.commit()
    else:
        log.warning("job %s: worktree not removed: %s", job.id, res.get("error"))


async def retention(session: AsyncSession, project: Project) -> dict[str, Any]:
    """Remove done jobs' worktrees whose branch is merged, and the oldest beyond `keep_per_project`.
    Branches are never deleted. Returns hostprobe's listing (with disk use)."""
    status, data = await hostprobe_client.call(
        "GET", "/git/worktrees?" + urllib.parse.urlencode({"project": project.path, "slug": project.slug})
    )
    if status != 200:
        return {"error": data.get("error"), "worktrees": [], "bytes": None}
    by_id = {w["job_id"]: w for w in data.get("worktrees") or []}
    jobs = (
        await session.scalars(
            select(Job)
            .where(Job.project_id == project.id, Job.id.in_(list(by_id)), Job.status.in_(TERMINAL))
            .order_by(Job.finished_at.desc().nulls_last())
        )
    ).all()
    keep = load_agents().defaults.keep_per_project
    kept = 0
    for job in jobs:
        w = by_id[job.id]
        merged = w.get("merged") and w.get("tip") and w.get("tip") != job.base_sha
        if merged or job.status != "done" or kept >= keep:
            await remove_worktree(session, job)
            if merged:
                await event(session, job, "branch_merged", branch=job.branch)
        else:
            kept += 1
    await session.commit()
    return data


# --- the loop -----------------------------------------------------------------------------------------
async def loop(stop_event: asyncio.Event | None = None) -> None:
    """Advance every active job every couple of seconds. Persisted state: safe to restart at any time."""
    pc = Paperclip()
    try:
        while not (stop_event and stop_event.is_set()):
            try:
                async with db.sessionmaker()() as session:
                    rows = (
                        await session.execute(
                            select(Job.id, Job.status)
                            .where(Job.status.in_(ACTIVE))
                            .order_by(Job.id)
                            .limit(200)
                        )
                    ).all()
                # Running and waiting jobs concurrently; queued ones one at a time in order, so two jobs
                # for one agent can't both see it free and start together.
                await asyncio.gather(*(advance(i, pc) for i, st in rows if st != "queued"))
                for i, st in rows:
                    if st == "queued":
                        await advance(i, pc)
            except Exception:  # noqa: BLE001
                log.exception("job loop step failed")
            await asyncio.sleep(LOOP_INTERVAL_S)
    finally:
        await pc.aclose()
