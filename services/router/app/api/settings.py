"""Settings page API (M1.5): caps and the private default, layered over config/rules.yaml."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import jobs, rules_versions, user_settings
from app.agents import load_agents
from app.db import get_session
from app.deps import require_admin

router = APIRouter(tags=["settings"])


class SettingsIn(BaseModel):
    """Partial update. `null` removes an override (back to the rules.yaml default)."""

    max_cost_usd: float | None = Field(default=None, ge=0, le=100)
    daily_cap_usd: float | None = Field(default=None, ge=0, le=100)
    private_by_default: bool | None = None
    explore: bool | None = None
    auto_private: bool | None = None
    approval_expiry_h: float | None = Field(default=None, ge=0, le=720)
    keep_worktrees_per_project: int | None = Field(default=None, ge=0, le=100)


async def _view(session: AsyncSession) -> dict[str, Any]:
    d = (await rules_versions.effective_rules(session)).defaults
    o = await user_settings.load(session)
    keep_default = load_agents().defaults.keep_per_project
    return {
        "max_cost_usd": o.get("max_cost_usd", d.max_cost_usd),
        "daily_cap_usd": o.get("daily_cap_usd", d.daily_cap_usd),
        "private_by_default": o.get("private_by_default", d.private),
        "explore": o.get("explore", False),
        "auto_private": o.get("auto_private", True),
        "approval_expiry_h": o.get("approval_expiry_h", jobs.APPROVAL_EXPIRY_DEFAULT_H),
        "keep_worktrees_per_project": o.get("keep_worktrees_per_project", keep_default),
        "defaults": {
            "max_cost_usd": d.max_cost_usd,
            "daily_cap_usd": d.daily_cap_usd,
            "private_by_default": d.private,
            "explore": False,
            "auto_private": True,
            "approval_expiry_h": jobs.APPROVAL_EXPIRY_DEFAULT_H,
            "keep_worktrees_per_project": keep_default,
        },
        "overridden": sorted(o),
    }


@router.get("/settings")
async def get_settings_view(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _view(session)


@router.put("/settings", dependencies=[Depends(require_admin)])
async def put_settings(body: SettingsIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    await user_settings.save(session, body.model_dump(exclude_unset=True))
    return await _view(session)
