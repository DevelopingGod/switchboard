"""The agent fleet (M4b, ADR 0009): hire agents from the agents.yaml templates, edit, pause, delete, reset.

`config/agents.yaml` stays the base (the verified CLI flags live there and nowhere else). Your changes are
rows in `agent_profiles`, merged on top by `app.agents.load_agents`:

- a **hired** agent has its own id and a `template` (claude-code, codex, opencode): it runs exactly like its
  template, with your name, role, model, default autonomy, monthly budget and allowed projects;
- an **edited built-in** agent is a row with `builtin = true` and the same id; "Reset to default" deletes it;
- deleting a hired agent sets `deleted_at`: it is never offered or run again, but its jobs and costs keep it.

Paperclip sync is idempotent and never read-modify-write (Paperclip redacts what it returns, docs/m4a.md):
the Paperclip agent itself is created by the job engine on the agent's first run (creating it runs Paperclip's
setup check, which starts the CLI); here only its name, pause state and termination follow your changes.
A Paperclip agent that is already gone counts as done.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import agents as agents_mod
from app import jobs
from app.agents import AgentDef, AgentRegistry, load_agents
from app.models import AgentProfile, Job, Project
from app.paperclip import Paperclip, PaperclipError

log = logging.getLogger("app.fleet")

COLUMNS = (
    "id",
    "template",
    "builtin",
    "label",
    "role",
    "model",
    "default_autonomy",
    "monthly_list_usd",
    "allowed_project_ids",
    "paused",
    "deleted_at",
)


class FleetError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _row(p: AgentProfile) -> dict[str, Any]:
    d = {c: getattr(p, c) for c in COLUMNS}
    d["monthly_list_usd"] = float(d["monthly_list_usd"]) if d["monthly_list_usd"] is not None else None
    d["deleted_at"] = d["deleted_at"].isoformat() if d["deleted_at"] else None
    return d


async def refresh(session: AsyncSession) -> AgentRegistry:
    """Load the overlay from the DB into the registry (cheap: one small table)."""
    rows = (await session.scalars(select(AgentProfile))).all()
    agents_mod.set_overlay([_row(r) for r in rows])
    return load_agents()


def slug_id(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:36]
    if not s or not s[0].isalpha():
        s = "agent-" + s
    return s.strip("-")


async def _validate(
    session: AsyncSession,
    tpl: AgentDef,
    *,
    label: str | None,
    model: str | None,
    default_autonomy: int | None,
    monthly_list_usd: float | None,
    allowed_project_ids: list[int] | None,
) -> None:
    reg = load_agents()
    if label is not None and not label.strip():
        raise FleetError(400, "Give the agent a name")
    if model and tpl.models and model not in tpl.models:
        raise FleetError(400, f"{tpl.label} can use: {', '.join(tpl.models)}")
    if model and not tpl.models:
        raise FleetError(400, f"{tpl.label} uses its own default model; it can't be changed here")
    if default_autonomy is not None:
        level = reg.levels.get(default_autonomy)
        if level is None:
            raise FleetError(400, "Autonomy is 0, 1, 2 or 3")
        why = tpl.level_unavailable(level)
        if why:
            raise FleetError(400, why)
    if monthly_list_usd is not None and monthly_list_usd <= 0:
        raise FleetError(400, "The monthly budget must be more than $0 (leave it empty for no monthly cap)")
    if allowed_project_ids is not None:
        found = set(
            (
                await session.scalars(
                    select(Project.id).where(
                        Project.id.in_(allowed_project_ids), Project.removed_at.is_(None)
                    )
                )
            ).all()
        )
        missing = [p for p in allowed_project_ids if p not in found]
        if missing:
            raise FleetError(400, "One of the chosen projects isn't on the Projects list any more")


async def hire(
    session: AsyncSession,
    pc: Paperclip | None,
    *,
    template: str,
    label: str,
    role: str | None,
    model: str | None,
    default_autonomy: int | None,
    monthly_list_usd: float | None,
    allowed_project_ids: list[int] | None,
) -> AgentDef:
    reg = await refresh(session)
    base = agents_mod.load_base()
    tpl = base.agents.get(template)
    if tpl is None:
        raise FleetError(400, f"No template called “{template}” (config/agents.yaml)")
    if not tpl.runnable:
        raise FleetError(400, tpl.note or f"{tpl.label} can't run jobs yet, so it can't be hired")
    await _validate(
        session,
        tpl,
        label=label,
        model=model,
        default_autonomy=default_autonomy,
        monthly_list_usd=monthly_list_usd,
        allowed_project_ids=allowed_project_ids,
    )
    names = {a.label.lower() for a in reg.agents.values()}
    if label.strip().lower() in names:
        raise FleetError(409, f"An agent called “{label.strip()}” already exists: pick another name")
    base_id = slug_id(label)
    aid, n = base_id, 2
    taken = set(base.agents) | set((await session.scalars(select(AgentProfile.id))).all())
    while aid in taken:
        aid, n = f"{base_id}-{n}", n + 1
    session.add(
        AgentProfile(
            id=aid,
            template=tpl.id,
            builtin=False,
            label=label.strip()[:80],
            role=(role or "").strip() or None,
            model=model or None,
            default_autonomy=default_autonomy,
            monthly_list_usd=monthly_list_usd,
            allowed_project_ids=allowed_project_ids,
            paused=False,
        )
    )
    await session.commit()
    reg = await refresh(session)
    return reg.agents[aid]


async def edit(session: AsyncSession, pc: Paperclip | None, agent_id: str, patch: dict[str, Any]) -> AgentDef:
    """Partial update (keys present in `patch` only). A built-in agent gets an overlay row on first edit."""
    reg = await refresh(session)
    a = reg.agents.get(agent_id)
    if a is None:
        raise FleetError(404, "No such agent")
    base = agents_mod.load_base()
    tpl = base.agents[a.template or a.id]
    await _validate(
        session,
        tpl,
        label=patch.get("label"),
        model=patch.get("model"),
        default_autonomy=patch.get("default_autonomy"),
        monthly_list_usd=patch.get("monthly_list_usd"),
        allowed_project_ids=patch.get("allowed_project_ids"),
    )
    if "label" in patch and patch["label"]:
        clash = [
            x
            for x in reg.agents.values()
            if x.id != a.id and x.label.lower() == patch["label"].strip().lower()
        ]
        if clash:
            raise FleetError(
                409, f"An agent called “{patch['label'].strip()}” already exists: pick another name"
            )
    row = await session.get(AgentProfile, agent_id)
    if row is None:  # first edit of a built-in agent
        row = AgentProfile(id=agent_id, template=agent_id, builtin=True, paused=False)
        session.add(row)
    for k in ("label", "role", "model", "default_autonomy", "monthly_list_usd", "allowed_project_ids"):
        if k in patch:
            v = patch[k]
            setattr(row, k, (v.strip() or None) if isinstance(v, str) else v)
    await session.commit()
    reg = await refresh(session)
    if pc is not None and "label" in patch:
        await _sync_name(session, pc, reg.agents[agent_id])
    return reg.agents[agent_id]


async def set_paused(session: AsyncSession, pc: Paperclip | None, agent_id: str, paused: bool) -> AgentDef:
    """Pause: no new jobs start for this agent (jobs already started finish; Stop ends them). Idempotent."""
    reg = await refresh(session)
    a = reg.agents.get(agent_id)
    if a is None:
        raise FleetError(404, "No such agent")
    row = await session.get(AgentProfile, agent_id)
    if row is None:
        row = AgentProfile(id=agent_id, template=agent_id, builtin=True, paused=paused)
        session.add(row)
    row.paused = paused
    await session.commit()
    reg = await refresh(session)
    if pc is not None:
        pid = await _paperclip_id(session, agent_id)
        if pid and not await _busy_in_paperclip(session, agent_id):
            try:
                await (pc.pause_agent(pid) if paused else pc.resume_agent(pid))
            except PaperclipError as e:  # the router's own pause is what counts; Paperclip mirrors it
                log.warning("agent %s: pause state not mirrored to Paperclip: %s", agent_id, e)
    return reg.agents[agent_id]


async def reset(session: AsyncSession, pc: Paperclip | None, agent_id: str) -> AgentDef:
    """A built-in agent back to config/agents.yaml (deletes its overlay row). Idempotent."""
    base = agents_mod.load_base()
    if agent_id not in base.agents:
        raise FleetError(400, "Only the built-in agents can be reset; a hired agent can be edited or deleted")
    row = await session.get(AgentProfile, agent_id)
    was_paused = bool(row and row.paused)
    if row is not None:
        await session.delete(row)
        await session.commit()
    reg = await refresh(session)
    if pc is not None:
        await _sync_name(session, pc, reg.agents[agent_id])
        pid = await _paperclip_id(session, agent_id)
        if was_paused and pid:
            try:
                await pc.resume_agent(pid)
            except PaperclipError as e:
                log.warning("agent %s: resume not mirrored to Paperclip: %s", agent_id, e)
    return reg.agents[agent_id]


async def delete(session: AsyncSession, pc: Paperclip | None, agent_id: str) -> None:
    """Soft-delete a hired agent (its jobs and costs keep it) and terminate its Paperclip agent. Deleting
    one that is already deleted is a success; a built-in agent can't be deleted (pause it instead)."""
    row = await session.get(AgentProfile, agent_id)
    if agent_id in agents_mod.load_base().agents:
        raise FleetError(400, "Built-in agents can't be deleted: pause it instead, or reset it to default")
    if row is None or row.deleted_at is not None:
        return
    active = await session.scalar(
        select(Job.id).where(Job.agent == agent_id, Job.status.in_(jobs.ACTIVE)).limit(1)
    )
    if active:
        raise FleetError(409, "This agent still has a job in progress: stop it or wait for it to finish")
    row.deleted_at = jobs.now()
    row.paused = True
    await session.commit()
    await refresh(session)
    if pc is not None:
        pid = await _paperclip_id(session, agent_id)
        if pid:
            try:
                await pc.terminate_agent(pid)
            except PaperclipError as e:
                log.warning("agent %s: not terminated in Paperclip: %s", agent_id, e)
            m = await jobs.meta(session)
            (m.get("agents") or {}).pop(agent_id, None)
            await jobs.save_meta(session, m)
            await session.commit()


async def _paperclip_id(session: AsyncSession, agent_id: str) -> str | None:
    return ((await jobs.meta(session)).get("agents") or {}).get(agent_id)


async def _busy_in_paperclip(session: AsyncSession, agent_id: str) -> bool:
    """Don't pause a Paperclip agent that still has a job in progress (a run would be cancelled, or the
    job's next run refused): the router's own pause is what stops new jobs."""
    return bool(
        await session.scalar(
            select(Job.id).where(Job.agent == agent_id, Job.status.in_(jobs.ACTIVE)).limit(1)
        )
    )


async def _sync_name(session: AsyncSession, pc: Paperclip, agent: AgentDef) -> None:
    pid = await _paperclip_id(session, agent.id)
    if not pid:
        return  # created on its first run, with the current name
    try:
        await pc.rename_agent(pid, f"Switchboard {agent.label}")
    except PaperclipError as e:
        log.warning("agent %s: name not mirrored to Paperclip: %s", agent.id, e)
