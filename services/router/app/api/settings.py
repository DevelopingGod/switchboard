"""Settings page API (M1.5): caps and the private default, layered over config/rules.yaml."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app import user_settings
from app.db import get_session
from app.deps import require_admin
from app.routing.rules import load_rules

router = APIRouter(tags=["settings"])


class SettingsIn(BaseModel):
    """Partial update. `null` removes an override (back to the rules.yaml default)."""

    max_cost_usd: float | None = Field(default=None, ge=0, le=100)
    daily_cap_usd: float | None = Field(default=None, ge=0, le=100)
    private_by_default: bool | None = None


async def _view(session: AsyncSession) -> dict[str, Any]:
    d = load_rules().defaults
    o = await user_settings.load(session)
    return {
        "max_cost_usd": o.get("max_cost_usd", d.max_cost_usd),
        "daily_cap_usd": o.get("daily_cap_usd", d.daily_cap_usd),
        "private_by_default": o.get("private_by_default", d.private),
        "defaults": {
            "max_cost_usd": d.max_cost_usd,
            "daily_cap_usd": d.daily_cap_usd,
            "private_by_default": d.private,
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
