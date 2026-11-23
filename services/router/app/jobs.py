"""Agent jobs (M4a, ADR 0007): Switchboard drives the phases, Paperclip runs the agents.

A job: one task, one allowlisted project, one agent (chosen from a fallback chain before its first run
starts, never switched mid-job), one autonomy level (config/agents.yaml `levels`).

    queued ─start→ running ─run ends→ running (next run) | needs_approval (plan | diff | result)
    needs_approval ─approve→ running (after the plan) | done      ─reject→ stopped
    any active state ─stop→ stopped;  a run that fails or a cap that trips → failed / stopped

M6.5 (ADR 0014): a run that ends on a subscription usage limit, or a job whose agents' windows are all used
up, **waits**: `waiting_reset` until `resume_at`, then the same phase runs again in the same worktree (the
run is told to check what the cut-off attempt left). A reset further away than `max_auto_wait_h` asks you
instead (`needs_approval`, gate `limit`: wait anyway, another agent, paid overflow, or cancel). A job is bound
to one account per CLI and never switches to another account of the same CLI (ADR 0013).

Each run: the agent's Paperclip config is set for that run (worktree, the level's flags, a clean
environment, the task), then one agent-level wake. One active run per agent (`max_active_per_agent`), the
rest wait in the queue. The job loop (`loop()`) advances active jobs; everything is persisted, so a restart
picks up where it was. Every change is appended to `job_events` (traceability, SPEC §13.5).

Worktrees come from hostprobe (ADR 0008): `switchboard/job-<id>` from the project's HEAD, outside the repo.

M4.5a (ADRs 0018/0019): before the first run, the job's packs are set up in its worktree by hostprobe (a
background task the loop polls; the job stays `queued` meanwhile). A pack workflow (`flow`, e.g. OpenSpec's
propose → apply → archive) replaces the level's runs with one edit run per step and a review (`step` gate)
after each; the last step ends at the usual diff review. graphify is used, or held out as a control, per
app/packs/service.py.
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

from app import accounts, db, hostprobe_client, overflow, subscriptions, user_settings
from app.agents import AgentDef, AgentRegistry, Level, build_run, load_agents
from app.config import get_settings
from app.job_output import TurnCounter, outcome
from app.models import Cost, Job, JobEvent, Project, SystemMeta
from app.packs import service as packs
from app.paperclip import TERMINAL_RUN, Paperclip, PaperclipError

log = logging.getLogger("app.jobs")

ACTIVE = ("queued", "running", "needs_approval", "waiting_reset")
TERMINAL = ("done", "failed", "stopped")
META_KEY = "paperclip"
COMPANY_NAME = "Switchboard"
LOOP_INTERVAL_S = 2.0
READY_WAIT_S = 90
LOG_PAGE_BYTES = 256 * 1024
SWEEP_INTERVAL_S = 300
ISSUE_STATUS = {
    "queued": "todo",
    "running": "in_progress",
    "needs_approval": "in_review",
    "waiting_reset": "blocked",
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


# --- small persistence helpers --------------------------------------------------------------------------
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


# --- availability ---------------------------------------------------------------------------------------
async def host_facts() -> tuple[dict[str, Any], bool | None]:
    """(hostprobe's CLI rows, whether bwrap exists). Never raises: unknown when hostprobe is down."""
    ok, data, _ = await hostprobe_client.probe("/cli", timeout=30)
    clis = (data or {}).get("clis") or {} if ok else {}
    ok_hw, hw, _ = await hostprobe_client.probe("/hw", timeout=15)
    bwrap = (hw or {}).get("bwrap") if ok_hw and hw else None
    return clis, bwrap


def month_start() -> datetime:
    t = now()
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def agent_spent_since(session: AsyncSession, agent_id: str, since: datetime) -> float:
    total = await session.scalar(
        select(func.coalesce(func.sum(Cost.list_price_usd), 0))
        .join(Job, Job.id == Cost.job_id)
        .where(Cost.source == "paperclip", Cost.created_at >= since, Job.agent == agent_id)
    )
    return float(total or 0)


async def agent_spent_today(session: AsyncSession, agent_id: str) -> float:
    return await agent_spent_since(session, agent_id, day_start())


async def agent_check(
    session: AsyncSession,
    reg: AgentRegistry,
    agent: AgentDef,
    level: Level,
    project_id: int,
    clis: dict[str, Any],
    bwrap: bool | None,
    *,
    account: str | None = None,
    light: bool = False,
    paid: bool = False,
) -> str | None:
    """Why `agent` can't take a job at `level` in this project now, or None. One rule set for the
    preview, the create check and the start (fallback) choice, so the preview says what will happen.

    M6.5: the account must exist and be logged in; a subscription window that is used up (or nearly, for
    light work) is a `subscriptions.WindowReason`, which lets the job wait for the reset instead of failing.
    The paid-overflow agent only runs for a job you confirmed as paid."""
    if agent.paid and not paid:
        return f"{agent.label} runs only when you confirm paid overflow for a job"
    if paid and not agent.paid:
        return f"{agent.label} isn't the paid-overflow agent"
    if agent.paused:
        return f"{agent.label} is paused (Agents page: Resume)"
    if agent.allowed_projects is not None and project_id not in agent.allowed_projects:
        return f"{agent.label} isn't allowed to work in this project (Agents page: Edit)"
    why = unavailable(reg, agent, level, clis, bwrap)
    if why:
        return why
    cli = reg.subscription(agent)
    if cli is not None and accounts.key(account) != accounts.DEFAULT:
        if not await accounts.exists(session, cli.id, account):
            return f"{agent.label}'s account “{account}” was removed (Settings → Accounts)"
        st = await accounts.status(cli.id, account)
        if st.get("logged_in") is False:
            return f"{agent.label}'s account “{account}” is not logged in: run `{st.get('login_command')}`"
    if agent.paid:
        ov = await overflow.status(session)
        if not ov["ready"]:
            return "Paid overflow is off, has no model or has no budget left this month"
        return None  # its spend is capped by the job's paid budget and the monthly overflow budget
    spent = await agent_spent_today(session, agent.id)
    cap = reg.defaults.per_agent_daily_list_usd
    if spent >= cap:
        return f"{agent.label} reached today's budget (${spent:.2f} of ${cap:.2f} list price)"
    monthly = (
        agent.monthly_list_usd
        if agent.monthly_list_usd is not None
        else reg.defaults.per_agent_monthly_list_usd
    )
    if monthly is not None:
        spent_m = await agent_spent_since(session, agent.id, month_start())
        if spent_m >= monthly:
            return f"{agent.label} reached this month's budget (${spent_m:.2f} of ${monthly:.2f} list price)"
    return await subscriptions.guard(session, reg, agent, account, light)


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


# --- Paperclip objects ----------------------------------------------------------------------------------
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
        if a.get("status") == "error":  # the previous run failed; this job starts fresh
            await pc.clear_error(pid)
            a = await pc.agent(pid) or a
        if state == "ready" and a.get("status") == "paused":
            # Paused in Paperclip (the fleet mirrors your pause there): Switchboard only runs an agent it
            # chose to run, so it resumes it for this run.
            await pc.resume_agent(pid)
            a = await pc.agent(pid) or a
        if state == "ready" and a.get("status") not in ("paused", "terminated", "pending_approval", "error"):
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


# --- settings the owner can change (Settings page; system_meta, over agents.yaml) -----------------------
APPROVAL_EXPIRY_DEFAULT_H = 24.0


async def approval_expiry_h(session: AsyncSession) -> float:
    o = await user_settings.load(session)
    return float(o.get("approval_expiry_h", APPROVAL_EXPIRY_DEFAULT_H))


async def keep_per_project(session: AsyncSession) -> int:
    o = await user_settings.load(session)
    return int(o.get("keep_worktrees_per_project", load_agents().defaults.keep_per_project))


# --- creating a job -------------------------------------------------------------------------------------
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
    rule_id: str | None = None,
    paid_budget_usd: float | None = None,
    files: list[Any] | None = None,
    flow: str | None = None,
) -> Job:
    """`paid_budget_usd` set = a paid-overflow job you confirmed ("Paid — up to $X"): it runs on the paid
    agent only, within that budget and this month's overflow budget (ADR 0015)."""
    reg = load_agents()
    level = reg.levels.get(autonomy)
    if level is None:
        raise JobError(400, "autonomy must be 0, 1, 2 or 3")
    if level.needs_budget and budget_list_usd is None:
        raise JobError(400, "Level 3 needs a budget for this job (budget_list_usd)")
    paid = paid_budget_usd is not None
    if paid:
        chain = [paid_agent(reg).id]
        try:
            await overflow.check(session, float(paid_budget_usd or 0))
        except overflow.OverflowError as e:
            raise JobError(e.status, e.message) from e
    known = [a for a in chain if a in reg.agents and (paid or not reg.agents[a].paid)]
    if not known:
        raise JobError(400, "none of these agents is in config/agents.yaml")
    bound = chain_accounts(reg, known, project)  # raises if one CLI would use two accounts
    if flow:  # M4.5a: every agent that may take the job must be able to run the workflow
        if paid:
            raise JobError(400, "Paid overflow jobs don't run pack workflows")
        for aid in known:
            why = packs.check_flow(flow, project, reg.agents[aid], autonomy)
            if why:
                raise JobError(400, why)
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
        account=bound.get(reg.agents[known[0]].cli),
        rule_id=rule_id,
        paid=paid,
        paid_budget_usd=paid_budget_usd,
        flow=flow or None,
    )
    session.add(job)
    await session.flush()
    await event(
        session,
        job,
        "created",
        agent_chain=known,
        autonomy=autonomy,
        project=project.path,
        budget=budget,
        accounts={k: accounts.key(v) for k, v in bound.items()},
        **({"paid_budget": paid_budget_usd} if paid else {}),
        **({"flow": flow} if flow else {}),
    )
    if files:  # M2.5: the job's own copy of each file, named in the task (in the same commit as the job)
        from app.attachments import service as att_service

        rows = att_service.attach_to_job(files, job.id)
        session.add_all(rows)
        job.prompt = job.prompt + att_service.job_prompt_note(rows)
        await event(session, job, "attachments", files=[a.name for a in rows])
    await session.commit()
    return job


def paid_agent(reg: AgentRegistry) -> AgentDef:
    found = next((a for a in reg.agents.values() if a.paid), None)
    if found is None:
        raise JobError(409, "config/agents.yaml has no paid-overflow agent")
    return found


def chain_accounts(reg: AgentRegistry, chain: list[str], project: Project | None) -> dict[str, str | None]:
    """cli -> the one account this job uses for it (ADR 0013). Two agents of one CLI on different accounts
    in one chain would be a switch of accounts on a limit, so it is refused."""
    bound: dict[str, str | None] = {}
    for aid in chain:
        agent = reg.agents.get(aid)
        if agent is None or reg.subscription(agent) is None:
            continue
        acct = accounts.resolve(reg, agent, project)
        why = accounts.switch_reason(reg, agent, acct, bound)
        if why:
            raise JobError(400, why + ". Pick agents of other providers as fallbacks.")
        bound.setdefault(agent.cli, acct)
    return bound


def job_light(reg: AgentRegistry, job: Job) -> bool:
    return subscriptions.is_light(reg, job.autonomy, job.rule_id)


# --- preview: exactly what a job would do (the confirm dialog shows these words as they are) ------------
def _minutes(seconds: int) -> str:
    m = max(1, round(seconds / 60))
    return f"{m} minute{'s' if m != 1 else ''}"


async def preview(
    session: AsyncSession,
    *,
    project: Project,
    chain: list[str],
    autonomy: int,
    budget_list_usd: float | None,
    rule_id: str | None = None,
    paid_budget_usd: float | None = None,
    flow: str | None = None,
) -> dict[str, Any]:
    """What `create` + the job loop would do with these choices, without writing anything. The agent check
    is the one the loop uses before the first run (`agent_check`), so the preview can't promise an agent
    the loop would skip; only a busy agent (the job waits in the queue) is decided later."""
    reg = load_agents()
    level = reg.levels.get(autonomy)
    if level is None:
        raise JobError(400, "autonomy must be 0, 1, 2 or 3")
    budget = budget_list_usd if budget_list_usd is not None else reg.defaults.per_job_list_usd
    clis, bwrap = await host_facts()
    rows: list[dict[str, Any]] = []
    chosen: AgentDef | None = None
    paid = paid_budget_usd is not None
    if paid:
        chain = [paid_agent(reg).id]
    try:
        bound = chain_accounts(reg, [a for a in chain if a in reg.agents], project)
        chain_problem = None
    except JobError as e:
        bound, chain_problem = {}, e.message
    light = subscriptions.is_light(reg, autonomy, rule_id)
    waits: list[datetime] = []
    for aid in chain:
        agent = reg.agents.get(aid)
        if agent is None:
            rows.append({"id": aid, "label": reg.label(aid), "reason": "Not in the fleet", "chosen": False})
            continue
        acct = bound.get(agent.cli) if reg.subscription(agent) else None
        why = await agent_check(
            session, reg, agent, level, project.id, clis, bwrap, account=acct, light=light, paid=paid
        )
        cli = reg.subscription(agent)
        window = None
        if cli is not None:
            window = subscriptions.tightest(await subscriptions.windows(session, reg, cli, acct))
        if isinstance(why, subscriptions.WindowReason) and why.until:
            waits.append(why.until)
        rows.append(
            {
                "id": aid,
                "label": agent.label,
                "reason": why,
                "chosen": why is None and chosen is None,
                "account": accounts.key(acct) if cli else None,
                "window": window,
                "paid": agent.paid,
            }
        )
        if why is None and chosen is None:
            chosen = agent
    window_only = (
        chosen is None
        and bool(rows)
        and any(isinstance(r["reason"], subscriptions.WindowReason) for r in rows)
    )
    waits_until = min(waits) if window_only and waits else None
    problem = None
    if chain_problem:
        problem = chain_problem
    elif paid:
        try:
            await overflow.check(session, float(paid_budget_usd or 0))
        except overflow.OverflowError as e:
            problem = e.message
    if not problem and flow:
        if paid:
            problem = "Paid overflow jobs don't run pack workflows"
        else:
            for aid in chain:
                agent = reg.agents.get(aid)
                why = packs.check_flow(flow, project, agent, autonomy) if agent else None
                if why:
                    problem = why
                    break
    if problem:
        pass
    elif level.needs_budget and budget_list_usd is None:
        problem = "Level 3 needs a budget for this job"
    elif window_only:
        problem = None  # it waits for the reset (or asks you, if that is far away); see `waits_until`
    elif chosen is None:
        problem = "No agent can take this job now: " + "; ".join(
            f"{r['label']}: {r['reason']}" for r in rows if r["reason"]
        )
    steps: list[str] = []
    if chosen is not None:
        who = chosen.label
        steps.append(
            f"Switchboard makes a separate copy of {project.name} (a git worktree) on a new branch, "
            "switchboard/job-<number>. Your own folder and branch aren't touched."
        )
        cmds = ", ".join(reg.defaults.allowed_commands[:4])
        ref = packs.flow_ref(flow)
        if ref is not None:
            fpack, fflow = ref
            steps.append(
                f"{fpack.name} is set up inside that copy only (its files are never committed). "
                f"Then {who} works "
                f"through {fflow.label}, one step at a time, and you review each step before the next: "
                + ", ".join(st.label for st in fflow.steps)
                + "."
            )
        if ref is not None:
            pass
        elif "read_only" in level.runs:
            steps.append(
                f"{who} reads the project and writes "
                + ("a plan" if level.approve_plan else "a report")
                + ". It can't change files or run commands."
            )
        if level.approve_plan and ref is None:
            steps.append("Nothing more happens until you approve the plan (or reject it with a note).")
        if "edit" in level.runs or ref is not None:
            steps.append(
                f"{who} edits files in the copy and may only run test commands (such as {cmds}). "
                "No internet, no installs, no push."
            )
        if level.review == "diff":
            steps.append(
                "You review the changes file by file. Approving commits them on the job's branch; "
                "rejecting throws the copy away."
            )
        else:
            steps.append("You review the report. Nothing is changed or committed.")
        limit = (
            f"${budget:.2f} list price, {reg.defaults.max_turns} turns or "
            f"{_minutes(reg.defaults.run_timeout_s)} per run, whichever comes first"
            if chosen.cost == "reported"
            else f"{reg.defaults.max_turns} turns or {_minutes(reg.defaults.run_timeout_s)} per run "
            f"({who} doesn't report its cost)"
        )
        steps.append(f"It stops at {limit}.")
        later = [r["label"] for r in rows[rows.index(next(r for r in rows if r["chosen"])) + 1 :]]
        if later:
            steps.append(
                f"If {who} can't start, {', then '.join(later)} takes the job instead "
                "(only before it starts)."
            )
        steps.append("Nothing is pushed. To use the work, review and merge the branch yourself.")
        if paid:
            steps.insert(
                0,
                f"Paid: this job runs on a paid model through LiteLLM and may spend up to "
                f"${float(paid_budget_usd or 0):.2f} of real money (this month's paid-overflow budget).",
            )
    elif window_only:
        steps.append(
            "Every agent in the list has used up its subscription window, so the job waits and starts by "
            "itself after the reset"
            + (
                f" (more than {reg.defaults.max_auto_wait_h:g} h away: it asks you first)"
                if waits_until and waits_until - now() > timedelta(hours=reg.defaults.max_auto_wait_h)
                else ""
            )
            + ". You can cancel it, or use paid overflow if you turned it on."
        )
    ov = await overflow.status(session)
    return {
        "ok": problem is None,
        "problem": problem,
        "project": {"id": project.id, "name": project.name, "path": project.path},
        "autonomy": autonomy,
        "level": {
            "runs": list(level.runs),
            "review": level.review,
            "approve_plan": level.approve_plan,
        },
        "agents": rows,
        "agent": chosen.id if chosen else None,
        "budget_list_usd": budget,
        "cost_reported": chosen.cost == "reported" if chosen else None,
        "caps": {
            "max_turns": reg.defaults.max_turns,
            "run_timeout_s": reg.defaults.run_timeout_s,
            "job_timeout_s": reg.defaults.job_timeout_s,
        },
        "branch": "switchboard/job-<number>",
        "steps": steps,
        "waits_until": waits_until.isoformat() if waits_until else None,
        "paid": paid,
        "paid_budget_usd": paid_budget_usd,
        "overflow": {"ready": ov["ready"], "left_usd": ov["left_usd"], "model": ov["model"]},
        "flow": flow or None,
    }


# --- the state machine ----------------------------------------------------------------------------------
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
                elif job.status == "waiting_reset":
                    await _check_resume(session, pc, job)
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
        bound = chain_accounts(reg, [a for a in job.agent_chain if a in reg.agents], project)
        light = job_light(reg, job)
        waits: list[datetime | None] = []
        for aid in job.agent_chain:
            agent = reg.agents.get(aid)
            if agent is None:
                reasons.append({"agent": aid, "reason": f"{reg.label(aid)} was removed from the fleet"})
                continue
            acct = bound.get(agent.cli) if reg.subscription(agent) else None
            why = await agent_check(
                session,
                reg,
                agent,
                level,
                job.project_id,
                clis,
                bwrap,
                account=acct,
                light=light,
                paid=job.paid,
            )
            if why is None:
                chosen = agent
                job.account = acct
                break
            if isinstance(why, subscriptions.WindowReason):
                waits.append(why.until)
            reasons.append({"agent": aid, "reason": why})
        if reasons:
            await event(session, job, "fallback", skipped=reasons, chosen=chosen.id if chosen else None)
        if chosen is None and waits:
            # Only usage windows stand in the way: wait for the earliest reset instead of failing.
            known = [w for w in waits if w is not None]
            await _wait(
                session,
                pc,
                job,
                min(known) if known else None,
                "Every agent for this job has used up its subscription window",
                interrupted=False,
            )
            return
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
    elif job.started_at and not job.paid:
        # The agent is fixed once a job has started: if its window is still used up, keep waiting.
        agent = reg.agents.get(job.agent)
        if agent is not None:
            why = await subscriptions.guard(session, reg, agent, job.account, light=False)
            if why is not None:
                await _wait(session, pc, job, why.until, str(why), interrupted=False)
                return
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
        if not await _copy_attachments(session, pc, job, project):
            return
    if job.run_index == 0 and not job.started_at and not await _setup_packs(session, pc, job, project):
        return  # set up in the background; the loop checks again
    await _start_run(session, pc, job, company)


async def _setup_packs(session: AsyncSession, pc: Paperclip, job: Job, project: Project) -> bool:
    """M4.5a: set the job's packs up in its worktree (hostprobe, a background task). True when done."""
    state = (job.packs or {}).get("state")
    if state == "ready":
        return True
    reg = load_agents()
    agent = reg.agents[job.agent]
    body = {"project": project.path, "slug": project.slug, "job_id": job.id}
    if state is None:
        if job.paid:
            job.packs = {"state": "ready", "requested": []}
            await session.commit()
            return True
        reqs, info = await packs.job_requests(session, project, job, agent, body)
        if not reqs:  # nothing to set up (why graphify wasn't used is kept in jobs.packs for the job page)
            job.packs = {**info, "state": "ready"}
            await session.commit()
            return True
        job.packs = {**info, "state": "setting_up", "reqs": reqs, "since": now().isoformat()}
        await event(session, job, "packs_setup", packs=[r["id"] for r in reqs], graphify=info.get("graphify"))
        await session.commit()
    rec = dict(job.packs or {})
    task = rec.get("task")
    if task:
        status, res = await hostprobe_client.call("GET", f"/packs/tasks/{task}", timeout=20)
        if status == 404:
            task = None  # hostprobe restarted: ask again (a finished setup answers from its record)
    if not task:
        status, res = await hostprobe_client.call(
            "POST", "/git/worktrees/packs", {**body, "packs": rec.get("reqs") or []}, timeout=60
        )
        if status != 200:
            return await _packs_failed(session, pc, job, rec, str(res.get("error") or f"hostprobe {status}"))
        rec["task"] = res.get("id")
        job.packs = rec
        await session.commit()
    if res.get("state") == "running":
        since = datetime.fromisoformat(rec["since"]) if rec.get("since") else now()
        if now() - since > timedelta(seconds=packs.config().setup_timeout_s):
            return await _packs_failed(session, pc, job, rec, "setting the packs up took too long")
        return False
    if res.get("state") != "ok":
        return await _packs_failed(session, pc, job, rec, str(res.get("error") or "pack setup failed"))
    summary = packs.setup_summary(res.get("result") or {})
    rec.update(state="ready", setup=summary)
    rec.pop("reqs", None)
    g = dict(rec.get("graphify") or {})
    if g.get("used") and g.get("pack") not in summary["packs"]:
        why = next(
            (r["reason"] for r in summary["refused"] if r.get("id") == g.get("pack")), "it wasn't set up"
        )
        g.update(used=False, eligible=False, reason=f"graph not used: {why}")
    elif g.get("used"):
        gp = summary["packs"][g["pack"]]
        g.update(
            build_ms=sum(st.get("ms") or 0 for st in gp.get("steps") or []),
            nodes=(gp.get("graph_stats") or {}).get("nodes"),
        )
    rec["graphify"] = g
    job.packs = rec
    ref = packs.flow_ref(job.flow)
    await event(
        session,
        job,
        "packs_ready",
        packs={
            k: {
                "version": v["version"],
                "owned": len(v["owned"]),
                "artifacts": len(v["artifacts"]),
                "edits": [e["path"] for e in v["edits"]],
                "verify_ms": v.get("verify_ms"),
            }
            for k, v in summary["packs"].items()
        },
        refused=summary["refused"],
        graphify=g,
    )
    await session.commit()
    if ref is not None and ref[0].id not in summary["packs"]:
        why = next((r["reason"] for r in summary["refused"] if r.get("id") == ref[0].id), "it wasn't set up")
        await _finish(session, pc, job, "failed", f"{ref[0].name} couldn't be set up: {why}")
        return False
    return True


async def _packs_failed(
    session: AsyncSession, pc: Paperclip, job: Job, rec: dict[str, Any], why: str
) -> bool:
    """A job without a workflow goes on without its packs (graphify off); a workflow job can't."""
    rec = {**rec, "state": "ready", "error": why}
    rec.pop("reqs", None)
    g = dict(rec.get("graphify") or {})
    if g.get("used"):
        g.update(used=False, eligible=False, reason=f"graph not used: {why}")
    rec["graphify"] = g
    job.packs = rec
    await event(session, job, "packs_failed", error=why)
    await session.commit()
    if job.flow:
        await _finish(session, pc, job, "failed", f"The job's packs couldn't be set up: {why}")
        return False
    return True


async def _copy_attachments(session: AsyncSession, pc: Paperclip, job: Job, project: Project) -> bool:
    """M2.5: put the job's files into its worktree (hostprobe; git-ignored, never committed)."""
    from app.models import Attachment

    files = list((await session.execute(select(Attachment).where(Attachment.job_id == job.id))).scalars())
    if not files:
        return True
    status, res = await hostprobe_client.call(
        "POST",
        "/git/worktrees/attachments",
        {
            "project": project.path,
            "slug": project.slug,
            "job_id": job.id,
            "files": [{"sha256": a.sha256, "name": a.name} for a in files],
        },
    )
    if status != 200:
        await _finish(session, pc, job, "failed", f"Couldn't copy the attached files: {res.get('error')}")
        return False
    await event(session, job, "attachments_copied", folder=res.get("folder"), files=len(files))
    await session.commit()
    return True


CUT_OFF_NOTE = (
    "\n\nNote: an earlier attempt at this step was cut off by a usage limit. Before you continue, check "
    "what is already in this folder (git status and git diff) so you don't repeat or duplicate that work."
)


def _task(job: Job, kind: str, agent: AgentDef | None = None) -> str:
    if job.flow and agent is not None:
        ft = packs.flow_task(job, agent)
        if ft is not None:
            return ft[1] + packs.agent_note(job) + (CUT_OFF_NOTE if job.attempt else "")
    return _task_text(job, kind) + packs.agent_note(job) + (CUT_OFF_NOTE if job.attempt else "")


def run_kind(job: Job, reg: AgentRegistry) -> str:
    """The kind of the job's current run: the level's, or `edit` for every step of a pack workflow."""
    if job.flow:
        return "edit"
    return reg.levels[job.autonomy].runs[job.run_index]


def run_count(job: Job, reg: AgentRegistry) -> int:
    return packs.flow_steps(job) if job.flow else len(reg.levels[job.autonomy].runs)


def _task_text(job: Job, kind: str) -> str:
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
    kind = run_kind(job, reg)
    agent = reg.agents[job.agent]
    left = float(job.budget_list_usd) - float(job.list_price_usd or 0)
    if left <= 0:
        await _finish(session, pc, job, "stopped", "The job's budget is used up")
        return
    account_home = None
    cli = reg.subscription(agent)
    if cli is not None and accounts.key(job.account) != accounts.DEFAULT:
        st = await accounts.status(cli.id, job.account)
        account_home = (st.get("env") or {}).get(cli.home_env)
        if not account_home:
            await _finish(session, pc, job, "failed", f"Couldn't find the folder of account “{job.account}”")
            return
    ov = None
    if agent.paid:
        try:
            key_file, model = await overflow.start_run_key(session, reg, job, agent.id)
        except overflow.OverflowError as e:
            await _finish(session, pc, job, "stopped", e.message)
            return
        ov = {"key_file": key_file, "model": model}
        await event(session, job, "paid_key", model=model, run_index=job.run_index, attempt=job.attempt)
    extra_env: dict[str, str] = {}
    bins = ((job.packs or {}).get("setup") or {}).get("bins") or []
    if bins:  # the pack wrappers first, then the PATH Paperclip runs agents with (ADR 0018)
        base = (await packs.installed()).get("service_path")
        if base:
            extra_env["PATH"] = ":".join([*bins, base])
    spec = build_run(
        reg,
        agent,
        kind,
        worktree=job.worktree_path or "",
        task=_task(job, kind, agent),
        budget_left_usd=left,
        account_home=account_home,
        overflow=ov,
        extra_env=extra_env,
        extra_allowed=packs.allowed_commands(job),
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
        if agent.paid:
            await overflow.end_run(job, agent.id)
        await _finish(session, pc, job, "failed", str(e))
        return
    suffix = f"-a{job.attempt}" if job.attempt else ""  # a re-run after a limit is a new run
    run = await pc.wake(
        pid, reason="switchboard_job", idempotency_key=f"switchboard-job-{job.id}-run-{job.run_index}{suffix}"
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
    job.resume_at = None
    await event(
        session,
        job,
        "run_started",
        run=run_id,
        run_kind=kind,
        agent=agent.id,
        autonomy=job.autonomy,
        account=accounts.key(job.account) if cli else None,
        attempt=job.attempt,
    )
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
    cli = reg.subscription(agent)
    if cli is not None and counter is not None and counter.readings:  # live usage window (Claude)
        await subscriptions.record(session, reg, cli.id, job.account, counter.take_readings())
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
            await _end_paid_run(session, job, agent)
            await _finish(session, pc, job, "stopped", reason)
            return
        await session.commit()
        return
    if counter is not None:
        counter.finish()
    out = await _record(session, job, agent, run, counter)
    _counters.pop(job.current_run_id or "", None)
    await _end_paid_run(session, job, agent)
    codex_hit = await _codex_usage(session, reg, job, agent, counter)
    injected = await _injected_limit(session, job, agent)
    if injected is not None:
        status, codex_hit = "failed", (True, injected)
    if status != "succeeded":
        hit, resets = limit_hit(reg, agent, run, counter)
        if hit or codex_hit[0]:
            until = resets or codex_hit[1]
            reported = until is not None
            await event(
                session, job, "limit_hit", agent=agent.id, resets=until.isoformat() if until else None
            )
            if cli is not None:
                until = await subscriptions.record_limit(session, reg, cli.id, job.account, until)
            await _wait(
                session,
                pc,
                job,
                until,
                f"{agent.label} hit its subscription usage limit",
                interrupted=True,
                estimated=not reported,
            )
            return
        what = {"cancelled": "stopped", "timed_out": "failed"}.get(status, "failed")
        msg = str(run.get("error") or f"The run ended: {status}")
        if (
            "max_budget" in msg
        ):  # Claude stopped itself at --max-budget-usd (the job's budget): a stop, not a fault
            what = "stopped"
            msg = f"Stopped at the job's budget (${float(job.budget_list_usd):.2f} list price)"
        await _finish(session, pc, job, what, msg[:500])
        return
    level = reg.levels[job.autonomy]
    kind = run_kind(job, reg)
    if job.flow:  # a pack workflow: a review after every step but the last (that one is the diff review)
        job.result_text = out.text
        if job.run_index + 1 < run_count(job, reg):
            await _gate(session, pc, job, "step", out.text)
            return
        await _gate(session, pc, job, "diff", out.text)
        return
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
    if job.paid:
        # Paid overflow: LiteLLM's spend log is the cost (the ingester files it under this job), so no row
        # here, or the tokens would count twice. The money is added to the job when its key is revoked.
        exists = await session.scalar(
            select(JobEvent.id).where(
                JobEvent.job_id == job.id,
                JobEvent.kind == "run_finished",
                JobEvent.data["run"].astext == str(run.get("id")),
            )
        )
        if exists is None:
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
                paid=True,
                started=run.get("startedAt"),
                finished=run.get("finishedAt"),
            )
            await session.commit()
        return out
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
                tokens_cached=out.tokens_cached,
                cost_usd=out.cost_usd,
                list_price_usd=out.list_price_usd,
                external_id=ext,
                tag=job.tag,
                kind="job",
                job_id=job.id,
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
            tokens_cached=out.tokens_cached,
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
    title = {
        "plan": "Approve the plan",
        "step": "Review this step",
        "diff": "Review the changes",
        "result": "Review the result",
        "limit": "Wait for the usage limit to reset?",
    }[gate]
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


async def waiting_since(session: AsyncSession, job: Job) -> datetime | None:
    """When the job started waiting for you (its last `needs_approval` event)."""
    return await session.scalar(
        select(JobEvent.created_at)
        .where(JobEvent.job_id == job.id, JobEvent.kind == "needs_approval")
        .order_by(JobEvent.id.desc())
        .limit(1)
    )


async def _check_approval(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    """An approval decided in Paperclip's own UI counts too. A job left waiting longer than the approval
    expiry (Settings, default 24 h) is stopped with a plain reason, so it doesn't hold a worktree forever."""
    hours = await approval_expiry_h(session)
    since = await waiting_since(session, job)
    if hours and since and now() - since > timedelta(hours=hours):
        if job.paperclip_approval_id:
            try:
                await pc.decide(job.paperclip_approval_id, False, f"Expired after {hours:g} h in Switchboard")
            except PaperclipError as e:
                log.warning("job %s: expiry not mirrored to Paperclip: %s", job.id, e)
        await event(session, job, "approval_expired", gate=job.gate, hours=hours)
        await _finish(
            session,
            pc,
            job,
            "stopped",
            (
                f"Waited {hours:g} h for your answer about the usage limit, so it was stopped. "
                if job.gate == "limit"
                else f"Waited {hours:g} h for your approval of the {job.gate or 'job'}, so it was stopped. "
            )
            + "Use Run again on the job page if you still want it.",
        )  # a stopped job's worktree is removed (retention rule); its branch stays
        return
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
    include_setup_edits: list[str] | None = None,
) -> None:
    if job.status != "needs_approval" or not job.gate:
        raise JobError(409, f"Job {job.id} isn't waiting for approval (it is {job.status})")
    gate = job.gate
    if gate == "limit":  # the long-wait question: approve = wait anyway, reject = cancel
        if approve:
            if not mirror:
                job.paperclip_approval_id = None  # decided in Paperclip already
            await wait_anyway(session, pc, job)
            return
        await event(session, job, "rejected", gate=gate, note=note, by=by)
        await _finish(session, pc, job, "stopped", "You chose not to wait for the usage limit to reset")
        return
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
    if gate in ("plan", "step"):
        job.run_index += 1
        job.gate = None
        job.status = "queued"  # the next run starts when the agent is free
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
                "message": _commit_message(job),
                "include_setup_edits": include_setup_edits or [],
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
            left_out=res.get("left_out") or [],
            included=include_setup_edits or [],
        )
    await _finish(session, pc, job, "done", None, keep_worktree=gate == "diff" and level.review == "diff")


def _commit_message(job: Job) -> str:
    """A short subject (git log stays readable) and the full title and agent in the body."""
    head = f"Switchboard job {job.id}: "
    title = " ".join(job.title.split())
    subject = head + (title if len(head + title) <= 72 else title[: 71 - len(head)].rstrip() + "…")
    return f"{subject}\n\n{title[:300]}\n\nAgent: {job.agent}, autonomy {job.autonomy}"[:500]


async def stop(session: AsyncSession, pc: Paperclip, job: Job, by: str = "you") -> None:
    if job.status in TERMINAL:
        return
    if job.current_run_id:
        await pc.cancel_run(job.current_run_id)
        # Count what the stopped run had already used (budgets stay honest).
        run = await pc.run(job.current_run_id)
        if run is not None:
            agent = load_agents().agents.get(job.agent)
            if agent is not None:
                await read_new_output(pc, job, agent)
                counter = _counters.pop(job.current_run_id, None)
                if counter is not None:
                    counter.finish()
                await _record(session, job, agent, run, counter)
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
    if job.paid:  # whatever the outcome, no paid key or key file outlives the job (ADR 0015)
        reg = load_agents()
        agent = reg.agents.get(job.agent) or reg.retired.get(job.agent)
        if agent is not None and agent.paid:
            await _end_paid_run(session, job, agent)
    job.status = status
    job.error = error
    job.finished_at = now()
    job.current_run_id = None
    job.resume_at = None
    if status != "done":
        job.gate = None
    await event(session, job, status, error=error)
    await session.commit()
    if status == "done":
        await _graph_outcome(session, job)
    if not keep_worktree:
        await remove_worktree(session, job)
    await _issue(pc, session, job)
    if job.paperclip_issue_id and error:
        try:
            await pc.comment(job.paperclip_issue_id, f"Job {status}: {error}")
        except PaperclipError:
            pass


async def _graph_outcome(session: AsyncSession, job: Job) -> None:
    """ADR 0019: a finished job of a measuring group may complete the round and decide."""
    g = (job.packs or {}).get("graphify") or {}
    if not g.get("eligible") or not g.get("group"):
        return
    project = await session.get(Project, job.project_id)
    if project is None:
        return
    try:
        decided = await packs.reconsider(session, project, g["group"])
    except Exception:  # noqa: BLE001 - measuring never breaks a job's finish
        log.exception("job %s: graphify measuring failed", job.id)
        return
    if decided:
        await event(session, job, "graphify_decided", **decided)
    await session.commit()


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
        from app.attachments import store as att_store

        att_store.remove_dir(att_store.job_dir(job.id))  # the job's copies of its files (M2.5)
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
    keep = await keep_per_project(session)
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


# --- subscription limits (M6.5, ADR 0014) ---------------------------------------------------------------
def limit_hit(
    reg: AgentRegistry, agent: AgentDef, run: dict[str, Any], counter: TurnCounter | None
) -> tuple[bool, datetime | None]:
    """Did this failed run end on a subscription usage limit? (and its reset, when the CLI said)."""
    cli = reg.subscription(agent)
    if cli is None:
        return False, None
    if counter is not None and counter.limit_hit:
        return True, counter.limit_resets
    text = " ".join(
        [
            str(run.get("error") or ""),
            str(run.get("errorCode") or ""),
            json.dumps(run.get("resultJson") or "")[:4000],
            counter.error_text() if counter is not None else "",
        ]
    ).lower()
    return any(p in text for p in cli.limit_patterns), None


async def _codex_usage(
    session: AsyncSession, reg: AgentRegistry, job: Job, agent: AgentDef, counter: TurnCounter | None
) -> tuple[bool, datetime | None]:
    """Codex reports its window only in its own session file: hostprobe reads the numbers by thread id."""
    cli = reg.subscription(agent)
    if cli is None or cli.usage != "session_file" or counter is None or not counter.thread_id:
        return False, None
    code, data = await hostprobe_client.call(
        "POST", "/codex/usage", {"thread_id": counter.thread_id, "account": accounts.key(job.account)}
    )
    readings = subscriptions.parse_codex(data) if code == 200 else []
    if readings:
        await subscriptions.record(session, reg, cli.id, job.account, readings)
    hit = [r for r in readings if r.limited]
    return bool(hit), max((r.resets_at for r in hit if r.resets_at), default=None)


async def _injected_limit(session: AsyncSession, job: Job, agent: AgentDef) -> datetime | None:
    """Dev only (`ROUTER_LIMIT_TEST=claude:resets_in=120`): the first run of that CLI in a job ends as if it
    hit its limit, to show waiting and resuming live without burning a real window (docs/m65.md)."""
    spec = get_settings().router_limit_test.strip()
    m = re.fullmatch(r"([a-z][a-z0-9-]*):resets_in=(\d{1,6})", spec)
    if not m or m.group(1) != agent.cli:
        return None
    done = await session.scalar(
        select(JobEvent.id).where(JobEvent.job_id == job.id, JobEvent.kind == "limit_injected").limit(1)
    )
    if done is not None:
        return None
    await event(session, job, "limit_injected", cli=agent.cli, test=True)
    return now() + timedelta(seconds=int(m.group(2)))


async def _end_paid_run(session: AsyncSession, job: Job, agent: AgentDef) -> None:
    """Revoke a paid run's key and remove its file (any outcome); add what it spent to the job."""
    if not agent.paid:
        return
    spent = await overflow.end_run(job, agent.id)
    if spent:
        job.cost_usd = float(job.cost_usd or 0) + spent
        job.list_price_usd = float(job.list_price_usd or 0) + spent
    await event(session, job, "paid_key_revoked", spent_usd=round(spent, 6))
    await session.commit()


async def _wait(
    session: AsyncSession,
    pc: Paperclip,
    job: Job,
    until: datetime | None,
    why: str,
    *,
    interrupted: bool,
    estimated: bool | None = None,
) -> None:
    """Wait for a usage window to reset. The worktree stays; the same phase runs again afterwards. A reset
    further away than `max_auto_wait_h` asks you first; too many waits end the job."""
    reg = load_agents()
    job.waits = (job.waits or 0) + 1
    if interrupted:
        job.attempt = (job.attempt or 0) + 1
    if job.waits > reg.defaults.max_waits:
        await _finish(
            session,
            pc,
            job,
            "failed",
            f"{why}, and it already waited for {reg.defaults.max_waits} resets. Run it again later, on "
            "another agent, or with paid overflow.",
            keep_worktree=False,
        )
        return
    estimated = until is None if estimated is None else estimated
    until = until or now() + timedelta(
        hours=reg.clis[next(iter(reg.clis))].windows[0].hours if reg.clis else 5
    )
    job.resume_at = until
    job.current_run_id = None
    if until - now() > timedelta(hours=reg.defaults.max_auto_wait_h):
        await event(session, job, "limit_wait_long", until=until.isoformat(), reason=why, estimated=estimated)
        await _gate(
            session,
            pc,
            job,
            "limit",
            f"{why}. It resets at {until.strftime('%Y-%m-%d %H:%M')} UTC, more than "
            f"{reg.defaults.max_auto_wait_h:g} h away, so the job asks before waiting. Wait anyway, run it "
            "on another agent, use paid overflow, or cancel.",
        )
        return
    job.status = "waiting_reset"
    job.gate = None
    await event(session, job, "waiting_reset", until=until.isoformat(), reason=why, estimated=estimated)
    await session.commit()
    await _issue(pc, session, job)


async def _check_resume(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    if job.resume_at and now() >= job.resume_at:
        job.status = "queued"
        await event(session, job, "resumed", at=now().isoformat(), attempt=job.attempt)
        await session.commit()
        await _issue(pc, session, job)


def _waiting_on_limit(job: Job) -> bool:
    return job.status == "waiting_reset" or (job.status == "needs_approval" and job.gate == "limit")


async def wait_anyway(session: AsyncSession, pc: Paperclip, job: Job) -> None:
    """ "Wait anyway" on a far reset: the job waits until `resume_at`, then continues by itself."""
    if not (job.status == "needs_approval" and job.gate == "limit"):
        raise JobError(409, f"Job {job.id} isn't asking about a long wait (it is {job.status})")
    await _decline_paperclip_approval(pc, job, "Waiting for the reset (chosen in Switchboard)", approve=True)
    job.status, job.gate, job.paperclip_approval_id = "waiting_reset", None, None
    await event(session, job, "wait_anyway", until=job.resume_at.isoformat() if job.resume_at else None)
    await session.commit()
    await _issue(pc, session, job)


async def _decline_paperclip_approval(pc: Paperclip, job: Job, note: str, approve: bool = False) -> None:
    if job.paperclip_approval_id:
        try:
            await pc.decide(job.paperclip_approval_id, approve, note)
        except PaperclipError as e:
            log.warning("job %s: decision not mirrored to Paperclip: %s", job.id, e)


async def reroute(session: AsyncSession, pc: Paperclip, job: Job, agent_id: str) -> None:
    """ "Run on another agent" for a job waiting on a limit: another CLI (never another account of the same
    CLI, ADR 0013). The interrupted phase starts again with that agent in the same worktree; this is the one
    exception to "the agent is fixed once a job starts", and it is your explicit choice (logged)."""
    if not _waiting_on_limit(job):
        raise JobError(409, f"Job {job.id} isn't waiting for a usage limit (it is {job.status})")
    reg = load_agents()
    agent = reg.agents.get(agent_id)
    current = reg.agents.get(job.agent) or reg.retired.get(job.agent)
    if agent is None or agent.paid:
        raise JobError(400, "Pick an agent from the fleet (paid overflow has its own button)")
    if current is not None and agent.cli == current.cli:
        raise JobError(
            400,
            f"{agent.label} uses {reg.clis[agent.cli].label if agent.cli in reg.clis else agent.cli} too: "
            "Switchboard never switches accounts of one provider to get around a limit. "
            "Pick another provider.",
        )
    project = await session.get(Project, job.project_id)
    acct = accounts.resolve(reg, agent, project)
    clis, bwrap = await host_facts()
    why = await agent_check(
        session, reg, agent, reg.levels[job.autonomy], job.project_id, clis, bwrap, account=acct
    )
    if why:
        raise JobError(409, str(why))
    await _decline_paperclip_approval(pc, job, f"Moved to {agent.label} in Switchboard")
    previous = job.agent
    job.agent, job.account = agent.id, acct
    job.agent_chain = [*job.agent_chain, agent.id] if agent.id not in job.agent_chain else job.agent_chain
    job.cost_reported = job.cost_reported and agent.cost == "reported"
    job.status, job.gate, job.resume_at, job.paperclip_approval_id = "queued", None, None, None
    job.attempt = (job.attempt or 0) + 1
    await event(session, job, "rerouted", previous=previous, agent=agent.id, by="you")
    await session.commit()
    await _issue(pc, session, job)


async def use_paid(session: AsyncSession, pc: Paperclip, job: Job, budget_usd: float) -> None:
    """ "Use paid overflow" for a job waiting on a limit, after you confirmed "Paid — up to $X"."""
    if not _waiting_on_limit(job):
        raise JobError(409, f"Job {job.id} isn't waiting for a usage limit (it is {job.status})")
    try:
        await overflow.check(session, budget_usd)
    except overflow.OverflowError as e:
        raise JobError(e.status, e.message) from e
    reg = load_agents()
    agent = paid_agent(reg)
    if job.autonomy not in [n for n, lv in reg.levels.items() if not agent.level_unavailable(lv)]:
        raise JobError(400, agent.level_unavailable(reg.levels[job.autonomy]) or "level not available")
    await _decline_paperclip_approval(pc, job, "Moved to paid overflow in Switchboard")
    previous = job.agent
    job.agent, job.account, job.paid, job.paid_budget_usd = agent.id, None, True, budget_usd
    job.agent_chain = [*job.agent_chain, agent.id]
    job.status, job.gate, job.resume_at, job.paperclip_approval_id = "queued", None, None, None
    job.attempt = (job.attempt or 0) + 1
    await event(session, job, "paid_overflow", previous=previous, budget=budget_usd, by="you")
    await session.commit()
    await _issue(pc, session, job)


async def sweep_overflow(session: AsyncSession) -> int:
    running = (
        await session.execute(select(Job.id, Job.agent).where(Job.paid.is_(True), Job.status == "running"))
    ).all()
    return await overflow.sweep(session, {(int(i), str(a)) for i, a in running})


# --- the loop -------------------------------------------------------------------------------------------
async def loop(stop_event: asyncio.Event | None = None) -> None:
    """Advance every active job every couple of seconds. Persisted state: safe to restart at any time."""
    from app import fleet  # fleet imports this module

    pc = Paperclip()
    last_sweep = 0.0
    try:
        while not (stop_event and stop_event.is_set()):
            try:
                async with db.sessionmaker()() as session:
                    await fleet.refresh(session)  # another worker's fleet edits, at most a step late
                    if time.monotonic() - last_sweep > SWEEP_INTERVAL_S:
                        last_sweep = time.monotonic()  # crash recovery: no paid key outlives its job
                        try:
                            await sweep_overflow(session)
                        except Exception:  # noqa: BLE001 - retried on the next sweep
                            log.exception("overflow sweep failed")
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
