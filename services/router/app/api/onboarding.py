"""First-run wizard state (SPEC §8b) and the goal -> provider mapping.

The wizard's progress lives here, not in the browser, so it resumes on any device. It is stored as
one JSON row in `system_meta` (key `onboarding`). The preset is saved now and applied by the M2
rules engine; nothing reads it yet.
"""

import json
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import require_admin
from app.models import SystemMeta
from app.registry import load_registry

router = APIRouter(tags=["onboarding"])
KEY = "onboarding"

Step = Literal["welcome", "goals", "connect", "preset", "finish"]
Preset = Literal["free", "balanced", "best"]


class OnboardingIn(BaseModel):
    """Partial update: only the fields sent change."""

    step: Step | None = None
    name: str | None = Field(default=None, max_length=60)
    goals: list[str] | None = Field(default=None, max_length=12)
    preset: Preset | None = None
    skipped: bool | None = None
    completed: bool | None = None


async def _load(session: AsyncSession) -> dict[str, Any] | None:
    row = await session.get(SystemMeta, KEY)
    return json.loads(row.value) if row else None


@router.get("/onboarding")
async def get_onboarding(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = load_registry()
    return {
        "state": await _load(session),
        "goals": {
            g: [{"provider": pid, "paid": reg.providers[pid].paid} for pid in ids]
            for g, ids in reg.goals.items()
        },
    }


@router.put("/onboarding", dependencies=[Depends(require_admin)])
async def put_onboarding(body: OnboardingIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = load_registry()
    unknown = [g for g in body.goals or [] if g not in reg.goals]
    if unknown:
        raise HTTPException(400, f"unknown goals: {unknown}")
    state = await _load(session) or {
        "step": "welcome",
        "name": "",
        "goals": [],
        "preset": None,
        "skipped": False,
        "completed_at": None,
    }
    patch = body.model_dump(exclude_none=True)
    done = patch.pop("completed", None)
    state.update(patch)
    if done is True:
        state["completed_at"] = datetime.now(UTC).isoformat()
        state["skipped"] = False
    elif done is False:
        state["completed_at"] = None
    state["name"] = state["name"].strip()
    row = await session.get(SystemMeta, KEY)
    if row is None:
        session.add(SystemMeta(key=KEY, value=json.dumps(state)))
    else:
        row.value = json.dumps(state)
    await session.commit()
    return {"state": state}
