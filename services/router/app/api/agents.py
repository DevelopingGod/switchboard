"""The agent fleet with live status (M4a; hire/edit/pause in M4b, ADR 0009).

GET    /agents                  every agent: installed, logged in, which levels it can run now and why not,
                                current job, success rate, budget used, cost
POST   /agents                  hire an agent from a template (claude-code, codex, opencode)
PATCH  /agents/{id}             edit (a built-in agent keeps its edits as an overlay)
POST   /agents/{id}/pause       no new jobs start for it (idempotent)
POST   /agents/{id}/resume
POST   /agents/{id}/reset       a built-in agent back to config/agents.yaml
DELETE /agents/{id}             a hired agent (soft delete: its jobs and costs keep it)
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import agents as agents_mod
from app import fleet, jobs
from app.agents import AgentDef, AgentRegistry
from app.db import get_session
from app.deps import require_admin
from app.models import Cost, Job
from app.paperclip import Paperclip

router = APIRouter(tags=["agents"], dependencies=[Depends(require_admin)])

SUCCESS_WINDOW_DAYS = 30


class HireIn(BaseModel):
    template: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=80)
    role: str | None = Field(default=None, max_length=2000)
    model: str | None = Field(default=None, max_length=120)
    default_autonomy: int | None = Field(default=None, ge=0, le=3)
    monthly_list_usd: float | None = Field(default=None, gt=0, le=10_000)
    allowed_project_ids: list[int] | None = Field(default=None, max_length=200)


class EditIn(BaseModel):
    """Partial: only the fields sent change. `null` clears a value (back to the template's)."""

    label: str | None = Field(default=None, min_length=1, max_length=80)
    role: str | None = Field(default=None, max_length=2000)
    model: str | None = Field(default=None, max_length=120)
    default_autonomy: int | None = Field(default=None, ge=0, le=3)
    monthly_list_usd: float | None = Field(default=None, gt=0, le=10_000)
    allowed_project_ids: list[int] | None = Field(default=None, max_length=200)


async def _stats(session: AsyncSession) -> dict[str, dict[str, Any]]:
    """Per agent, in three grouped queries (no per-agent loops over jobs): finished jobs in the last 30
    days, this month's list price and real cost, and the job in progress."""
    since = jobs.now() - timedelta(days=SUCCESS_WINDOW_DAYS)
    out: dict[str, dict[str, Any]] = {}
    for agent, status, n in (
        await session.execute(
            select(Job.agent, Job.status, func.count())
            .where(Job.finished_at >= since, Job.status.in_(("done", "failed")))
            .group_by(Job.agent, Job.status)
        )
    ).all():
        out.setdefault(agent, {})[status] = int(n)
    for agent, listed, real in (
        await session.execute(
            select(
                Job.agent,
                func.coalesce(func.sum(Cost.list_price_usd), 0),
                func.coalesce(func.sum(Cost.cost_usd), 0),
            )
            .join(Job, Job.id == Cost.job_id)
            .where(Cost.source == "paperclip", Cost.created_at >= jobs.month_start())
            .group_by(Job.agent)
        )
    ).all():
        out.setdefault(agent, {}).update(month_list=float(listed), month_cost=float(real))
    for j in (
        await session.scalars(
            select(Job).where(Job.status.in_(jobs.ACTIVE)).order_by(Job.id.desc()).limit(200)
        )
    ).all():
        d = out.setdefault(j.agent, {})
        d["active"] = d.get("active", 0) + 1
        if "current" not in d or j.status == "running":
            d["current"] = {"id": j.id, "title": j.title, "status": j.status}
    return out


def _agent_json(
    a: AgentDef, reg: AgentRegistry, clis: dict[str, Any], bwrap: bool | None, st: dict[str, Any]
) -> dict[str, Any]:
    row = clis.get(a.cli) or {}
    done, failed = st.get("done", 0), st.get("failed", 0)
    monthly = (
        a.monthly_list_usd if a.monthly_list_usd is not None else reg.defaults.per_agent_monthly_list_usd
    )
    return {
        "id": a.id,
        "label": a.label,
        "cli": a.cli,
        "template": a.template,
        "hired": a.hired,
        "edited": a.edited,
        "capabilities": list(a.capabilities),
        "runnable": a.runnable,
        "note": a.note,
        "installed": bool(row.get("installed")) and not row.get("windows_only"),
        "windows_only": bool(row.get("windows_only")),
        "logged_in": row.get("logged_in"),
        "version": row.get("version"),
        "cost": a.cost,
        "model": a.model,
        "models": list(a.models),
        "role": a.role,
        "default_autonomy": a.default_autonomy,
        "allowed_project_ids": list(a.allowed_projects) if a.allowed_projects is not None else None,
        "paused": a.paused,
        "levels": {str(n): jobs.unavailable(reg, a, lv, clis, bwrap) for n, lv in sorted(reg.levels.items())},
        "active_jobs": int(st.get("active", 0)),
        "current_job": st.get("current"),
        "success": {
            "done": done,
            "failed": failed,
            "rate": done / (done + failed) if done + failed else None,
        },
        "spent_today_list_usd": 0.0,  # filled by the caller (one query per runnable agent, few agents)
        "daily_budget_list_usd": reg.defaults.per_agent_daily_list_usd,
        "month_list_usd": round(st.get("month_list", 0.0), 4),
        "month_cost_usd": round(st.get("month_cost", 0.0), 4),
        "monthly_budget_list_usd": monthly,
    }


@router.get("/agents")
async def list_agents(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = await fleet.refresh(session)
    clis, bwrap = await jobs.host_facts()
    m = await jobs.meta(session)
    stats = await _stats(session)
    out = []
    for a in reg.agents.values():
        d = _agent_json(a, reg, clis, bwrap, stats.get(a.id, {}))
        if a.runnable:
            d["spent_today_list_usd"] = round(await jobs.agent_spent_today(session, a.id), 4)
        d["paperclip_agent_id"] = (m.get("agents") or {}).get(a.id)
        out.append(d)
    base = agents_mod.load_base()
    return {
        "agents": out,
        "templates": [
            {
                "id": t.id,
                "label": t.label,
                "runnable": t.runnable,
                "note": t.note,
                "installed": bool((clis.get(t.cli) or {}).get("installed"))
                and not (clis.get(t.cli) or {}).get("windows_only"),
                "models": list(t.models),
                "model": t.model,
                "levels": {str(n): t.level_unavailable(lv) for n, lv in sorted(reg.levels.items())},
            }
            for t in base.agents.values()
        ],
        "bwrap": bwrap,
        "defaults": {
            "max_active_per_agent": reg.defaults.max_active_per_agent,
            "per_job_list_usd": reg.defaults.per_job_list_usd,
            "per_agent_daily_list_usd": reg.defaults.per_agent_daily_list_usd,
            "per_agent_monthly_list_usd": reg.defaults.per_agent_monthly_list_usd,
            "max_turns": reg.defaults.max_turns,
            "run_timeout_s": reg.defaults.run_timeout_s,
        },
    }


async def _one(session: AsyncSession, a: AgentDef) -> dict[str, Any]:
    reg = agents_mod.load_agents()
    clis, bwrap = await jobs.host_facts()
    stats = await _stats(session)
    return _agent_json(a, reg, clis, bwrap, stats.get(a.id, {}))


def _err(e: fleet.FleetError) -> HTTPException:
    return HTTPException(e.status, e.message)


@router.post("/agents", status_code=201)
async def hire(body: HireIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    pc = Paperclip()
    try:
        a = await fleet.hire(session, pc, **body.model_dump())
    except fleet.FleetError as e:
        raise _err(e) from e
    finally:
        await pc.aclose()
    return await _one(session, a)


@router.patch("/agents/{agent_id}")
async def edit(agent_id: str, body: EditIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    pc = Paperclip()
    try:
        a = await fleet.edit(session, pc, agent_id, body.model_dump(exclude_unset=True))
    except fleet.FleetError as e:
        raise _err(e) from e
    finally:
        await pc.aclose()
    return await _one(session, a)


async def _pause(agent_id: str, paused: bool, session: AsyncSession) -> dict[str, Any]:
    pc = Paperclip()
    try:
        a = await fleet.set_paused(session, pc, agent_id, paused)
    except fleet.FleetError as e:
        raise _err(e) from e
    finally:
        await pc.aclose()
    return await _one(session, a)


@router.post("/agents/{agent_id}/pause")
async def pause(agent_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _pause(agent_id, True, session)


@router.post("/agents/{agent_id}/resume")
async def resume(agent_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _pause(agent_id, False, session)


@router.post("/agents/{agent_id}/reset")
async def reset(agent_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    pc = Paperclip()
    try:
        a = await fleet.reset(session, pc, agent_id)
    except fleet.FleetError as e:
        raise _err(e) from e
    finally:
        await pc.aclose()
    return await _one(session, a)


@router.delete("/agents/{agent_id}")
async def delete(agent_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    pc = Paperclip()
    try:
        await fleet.delete(session, pc, agent_id)
    except fleet.FleetError as e:
        raise _err(e) from e
    finally:
        await pc.aclose()
    return {"deleted": True}
