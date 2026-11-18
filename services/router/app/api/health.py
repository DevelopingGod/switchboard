"""Health and install-status endpoints (read by Docker healthcheck and scripts/doctor.sh)."""

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client, sync
from app.config import get_settings
from app.db import get_session
from app.registry import load_registry
from app.routing.rules import load_rules
from app.startup import env_keys_still_present, key_checks

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """`status` depends on the DB only. LiteLLM and hostprobe are reported, never fatal: the router
    must stay up (and the CLI rows show `unknown`) when hostprobe is down."""
    try:
        await session.execute(text("select 1"))
        db = "ok"
    except Exception:
        db = "down"
    litellm_ok = await request.app.state.litellm.alive()
    try:
        rules = f"ok ({len(load_rules().rules)} rules)"
    except Exception as e:  # a broken config/rules.yaml must show up in doctor.sh, not crash health
        rules = f"error: {str(e)[:160]}"
    return {
        "status": "ok" if db == "ok" else "degraded",
        "db": db,
        "litellm": "ok" if litellm_ok else "down",
        "hostprobe": "ok" if await hostprobe_client.alive() else "down",
        "rules": rules,
        "fault_injection": get_settings().router_fault_injection,
    }


@router.get("/system/status")
async def system_status(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rev = (await session.execute(text("select version_num from alembic_version"))).scalar_one_or_none()
    return {
        "alembic_revision": rev,
        "secret_keys": await key_checks(session),
        "env_keys_still_present": await env_keys_still_present(session, load_registry()),
        "background": {**getattr(request.app.state, "background", {}), "sync": sync.state.snapshot()},
    }
