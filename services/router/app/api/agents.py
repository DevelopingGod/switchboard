"""The agent registry with live status (M4a): installed, logged in, which autonomy levels each can run now,
today's list-price spend, and its Paperclip agent."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import jobs
from app.agents import load_agents
from app.db import get_session
from app.deps import require_admin
from app.models import Job

router = APIRouter(tags=["agents"], dependencies=[Depends(require_admin)])


@router.get("/agents")
async def list_agents(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = load_agents()
    clis, bwrap = await jobs.host_facts()
    m = await jobs.meta(session)
    counts = dict(
        (
            await session.execute(
                select(Job.agent, func.count()).where(Job.status.in_(jobs.ACTIVE)).group_by(Job.agent)
            )
        ).all()
    )
    out = []
    for a in reg.agents.values():
        row = clis.get(a.cli) or {}
        out.append(
            {
                "id": a.id,
                "label": a.label,
                "cli": a.cli,
                "capabilities": list(a.capabilities),
                "runnable": a.runnable,
                "note": a.note,
                "installed": bool(row.get("installed")) and not row.get("windows_only"),
                "windows_only": bool(row.get("windows_only")),
                "logged_in": row.get("logged_in"),
                "version": row.get("version"),
                "cost": a.cost,
                "levels": {
                    str(n): jobs.unavailable(reg, a, lv, clis, bwrap) for n, lv in sorted(reg.levels.items())
                },
                "active_jobs": int(counts.get(a.id, 0)),
                "spent_today_list_usd": round(await jobs.agent_spent_today(session, a.id), 4),
                "daily_budget_list_usd": reg.defaults.per_agent_daily_list_usd,
                "paperclip_agent_id": (m.get("agents") or {}).get(a.id),
            }
        )
    return {
        "agents": out,
        "bwrap": bwrap,
        "defaults": {
            "max_active_per_agent": reg.defaults.max_active_per_agent,
            "per_job_list_usd": reg.defaults.per_job_list_usd,
            "max_turns": reg.defaults.max_turns,
            "run_timeout_s": reg.defaults.run_timeout_s,
        },
    }
