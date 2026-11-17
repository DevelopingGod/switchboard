"""Status view data (M1.5): every component with a state and the fix the portal can offer.

The router only reports facts and stable codes; the portal turns them into one plain sentence and one
action (apps/portal/src/i18n/errors.ts). Fixes: `resync` (POST /system/resync), `retest:<provider>`
(POST /connections/<id>/test), `recheck_cli` (POST /connections/cli/refresh); anything else is an
instruction for the person (`start_docker`, `open_ollama`, `start_paperclip`, `start_hostprobe`).
"""

import asyncio
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client, secrets, sync
from app.config import get_settings
from app.db import get_session
from app.deps import litellm, require_admin
from app.errors import classify, problem
from app.litellm_admin import LiteLLMAdmin
from app.models import Connection
from app.registry import load_registry

router = APIRouter(tags=["system"])

PROBE_TTL_S = 15
_probe_cache: dict[str, tuple[float, bool, str | None]] = {}


async def _reachable(name: str, url: str) -> tuple[bool, str | None]:
    """GET with a 2 s limit, cached 15 s so the footer's polling never hammers anything."""
    hit = _probe_cache.get(name)
    if hit and time.monotonic() - hit[0] < PROBE_TTL_S:
        return hit[1], hit[2]
    try:
        async with httpx.AsyncClient(timeout=2) as c:
            r = await c.get(url)
        ok, err = r.status_code < 500, None if r.status_code < 500 else f"HTTP {r.status_code}"
    except httpx.HTTPError as e:
        ok, err = False, f"{type(e).__name__}"
    _probe_cache[name] = (time.monotonic(), ok, err)
    return ok, err


def _c(
    cid: str, status: str, fix: str | None = None, detail: str | None = None, **extra: Any
) -> dict[str, Any]:
    return {
        "id": cid,
        "status": status,
        "fix": fix,
        "detail": secrets.redact(detail)[:300] if detail else None,
        **extra,
    }


async def components(request: Request, session: AsyncSession) -> list[dict[str, Any]]:
    s = get_settings()
    try:
        await session.execute(text("select 1"))
        db_ok = True
    except Exception:
        db_ok = False
    (litellm_up, (ollama_ok, ollama_err), (pc_ok, pc_err), probe_up) = await asyncio.gather(
        request.app.state.litellm.alive(),
        _reachable("ollama", s.ollama_api_base.rstrip("/") + "/api/tags"),
        _reachable("paperclip", s.paperclip_url.rstrip("/") + "/api/health"),
        hostprobe_client.alive(),
    )
    st = sync.state
    sync_status = "ok" if st.status == "ok" else ("down" if st.status == "retrying" else "degraded")
    out = [
        _c("router", "ok"),
        _c("database", "ok" if db_ok else "down", None if db_ok else "start_docker"),
        _c("litellm", "ok" if litellm_up else "down", None if litellm_up else "start_docker"),
        _c(
            "model_sync",
            sync_status if litellm_up else "degraded",
            None if sync_status == "ok" else "resync",
            st.last_error,
            last_ok_at=st.last_ok_at.isoformat() if st.last_ok_at else None,
            next_retry_at=st.next_retry_at.isoformat() if st.next_retry_at else None,
        ),
        _c("ollama", "ok" if ollama_ok else "down", None if ollama_ok else "open_ollama", ollama_err),
        _c("paperclip", "ok" if pc_ok else "down", None if pc_ok else "start_paperclip", pc_err),
        _c("hostprobe", "ok" if probe_up else "down", "recheck_cli" if probe_up else "start_hostprobe"),
    ]
    # Providers needing attention: a failed test/catalog fetch, or a failed LiteLLM registration.
    registry = load_registry()
    for c in (await session.execute(select(Connection))).scalars():
        p = registry.get(c.provider)
        if p is None or p.kind == "cli":
            continue
        if c.provider in st.provider_errors:
            out.append(
                _c(
                    f"provider:{c.provider}",
                    "down",
                    "resync",
                    st.provider_errors[c.provider],
                    name=p.name,
                    code="gateway_sync",
                )
            )
        elif c.status == "error":
            out.append(
                _c(
                    f"provider:{c.provider}",
                    "down",
                    f"retest:{c.provider}",
                    c.last_error,
                    name=p.name,
                    code=classify(c.last_error),
                )
            )
    return out


@router.get("/system/components")
async def get_components(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    comps = await components(request, session)
    worst = (
        "down"
        if any(c["status"] == "down" for c in comps)
        else ("degraded" if any(c["status"] == "degraded" for c in comps) else "ok")
    )
    return {"status": worst, "components": comps}


@router.get("/system/sync")
async def get_sync() -> dict[str, Any]:
    return sync.state.snapshot()


@router.post("/system/resync", dependencies=[Depends(require_admin)])
async def resync(
    session: AsyncSession = Depends(get_session), admin: LiteLLMAdmin = Depends(litellm)
) -> dict[str, Any]:
    """The Status view's "Resync models" action: reconcile now. On failure the background task keeps
    trying."""
    try:
        changes = await sync.sync_once(session, admin, "resync requested")
    except Exception as e:
        sync.request("resync failed")
        raise problem(
            502, "gateway_sync", "Couldn't sync with the model gateway. Retrying automatically.", str(e)
        ) from None
    return {"ok": True, "litellm": {k: len(v) for k, v in changes.items()}, "sync": sync.state.snapshot()}
