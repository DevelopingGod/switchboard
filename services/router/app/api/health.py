"""Health and install-status endpoints (read by Docker healthcheck and scripts/doctor.sh)."""

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client, sync
from app.config import get_settings
from app.db import get_session
from app.local_profile import load_profiles
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
        rs = load_rules()
        rules = f"ok ({len(rs.rules)} rules, {len(rs.classifier.routes)} classifier routes)"
        load_profiles()  # config/local-models.yaml (M3a)
    except Exception as e:  # a broken config/rules.yaml must show up in doctor.sh, not crash health
        rules = f"error: {str(e)[:160]}"
    return {
        "status": "ok" if db == "ok" else "degraded",
        "db": db,
        "litellm": "ok" if litellm_ok else "down",
        "hostprobe": "ok" if await hostprobe_client.alive() else "down",
        "rules": rules,
        "fault_injection": get_settings().router_fault_injection,
        "quota_test_limits": get_settings().router_quota_test_limits or None,
        # M6.5: dev-only switches doctor.sh warns about, and the Metrics rollup worker (M6 carry-over)
        "limit_test": get_settings().router_limit_test or None,
        "overflow_allow_free": get_settings().router_overflow_allow_free,
        "rollups": await _rollups(session) if db == "ok" else None,
    }


async def _rollups(session: AsyncSession) -> dict[str, Any] | None:
    from app.metrics import rollup

    try:
        h = await rollup.health(session)
    except Exception:  # noqa: BLE001 - before migration 0009 there is nothing to report
        return None
    return {k: h[k] for k in ("state", "pending_buckets", "last_run_at")}


@router.get("/system/status")
async def system_status(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rev = (await session.execute(text("select version_num from alembic_version"))).scalar_one_or_none()
    return {
        "alembic_revision": rev,
        "secret_keys": await key_checks(session),
        "env_keys_still_present": await env_keys_still_present(session, load_registry()),
        "background": {**getattr(request.app.state, "background", {}), "sync": sync.state.snapshot()},
    }
