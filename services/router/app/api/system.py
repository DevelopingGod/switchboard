"""Status view data (M1.5): every component with a state and the fix the portal can offer.

The router only reports facts and stable codes; the portal turns them into one plain sentence and one
action (apps/portal/src/i18n/errors.ts). Fixes: `resync` (POST /system/resync), `retest:<provider>`
(POST /connections/<id>/test), `recheck_cli` (POST /connections/cli/refresh); anything else is an
instruction for the person (`start_docker`, `open_ollama`, `start_paperclip`, `start_hostprobe`).
"""

import asyncio
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import (
    accounts,
    credits,
    fleet,
    hostprobe_client,
    local_profile,
    ollama,
    quota,
    rules_versions,
    secrets,
    subscriptions,
    sync,
    user_settings,
)
from app.config import get_settings
from app.db import get_session
from app.deps import litellm, require_admin
from app.errors import classify, problem
from app.litellm_admin import LiteLLMAdmin
from app.metrics import rollup
from app.models import Connection
from app.paperclip import PINNED_VERSION as PAPERCLIP_PINNED
from app.paperclip import Paperclip
from app.registry import load_registry
from app.routing import classifier
from app.routing.context import connected_providers, spent_today, value_saved_today
from app.routing.health import cooldowns

router = APIRouter(tags=["system"])

PROBE_TTL_S = 15
_probe_cache: dict[str, tuple[float, bool, str | None]] = {}


async def _paperclip_listen() -> dict[str, Any]:
    """ADR 0007: with no login, Paperclip must only listen on loopback. hostprobe reads the listening
    addresses on the host (/proc/net/tcp). `checked` is false when it can't tell (hostprobe down, or the port
    not seen): no alarm then, and Status says the check couldn't run."""
    port = httpx.URL(get_settings().paperclip_url).port or 3100
    ok, data, _ = await hostprobe_client.probe(f"/net/listen?port={port}", timeout=5)
    if not ok or not data or not data.get("addresses"):
        return {"checked": False, "ok": None, "addresses": [], "port": port}
    return {
        "checked": True,
        "ok": bool(data.get("loopback_only")),
        "addresses": [str(a) for a in data.get("addresses") or []][:8],
        "port": port,
    }


# Plain facts shown on Status under Paperclip (M4b): its auth mode and the loopback check.
_pc_notes: dict[str, Any] = {}


async def _paperclip() -> tuple[str, str | None]:
    """Paperclip through the jobs adapter (M4a): a real `/api/health` (the old reachability check counted
    its 403 "hostname not allowed" as up), the pinned version, and its auth mode (ADR 0007). Cached like the
    others."""
    hit = _probe_cache.get("paperclip")
    if hit and time.monotonic() - hit[0] < PROBE_TTL_S:
        return hit[1], hit[2]
    client = Paperclip()
    try:
        h = await client.health()
    finally:
        await client.aclose()
    listen = await _paperclip_listen() if h else {"checked": False, "ok": None, "addresses": []}
    _pc_notes.clear()
    _pc_notes.update(
        {
            "auth": (h or {}).get("deploymentMode"),  # local_trusted = no login (local only)
            "exposure": (h or {}).get("deploymentExposure"),
            "version": (h or {}).get("version"),
            "pinned": PAPERCLIP_PINNED,
            "loopback": listen,
        }
    )
    if not h or h.get("status") != "ok":
        status, detail = "down", "Paperclip is not answering"
    elif h.get("version") != PAPERCLIP_PINNED:
        status = "degraded"
        detail = f"Paperclip {h.get('version')} is running; Switchboard is verified with {PAPERCLIP_PINNED}"
    elif listen["checked"] and not listen["ok"]:
        status = "down"
        detail = (
            "Paperclip listens beyond this computer and has no login: anyone on your network could run "
            "agents. Re-run its onboarding with --bind loopback"
        )
    elif h.get("deploymentMode") == "local_trusted":
        status, detail = "ok", "No login (local only): any program on this computer can use Paperclip"
    else:
        status, detail = "ok", None
    _probe_cache["paperclip"] = (time.monotonic(), status, detail)
    return status, detail


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
    (litellm_up, (ollama_ok, ollama_err), (pc_status, pc_detail), probe_up) = await asyncio.gather(
        request.app.state.litellm.alive(),
        _reachable("ollama", s.ollama_api_base.rstrip("/") + "/api/tags"),
        _paperclip(),
        hostprobe_client.alive(),
    )
    pc_ok = pc_status != "down"
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
        _c("paperclip", pc_status, None if pc_ok else "start_paperclip", pc_detail, notes=dict(_pc_notes)),
        _c("hostprobe", "ok" if probe_up else "down", "recheck_cli" if probe_up else "start_hostprobe"),
    ]
    # Local models (M3a): the active profile, its classifier, missing models.
    out += await _local_rows(ollama_ok)
    # M6.5: the Metrics rollup worker (M6 carry-over) and each subscription account's usage window.
    rh = await rollup.health(session)
    out.append(
        _c(
            "rollups",
            {"ok": "ok", "behind": "degraded", "stopped": "down"}[rh["state"]],
            None if rh["state"] == "ok" else "rebuild_rollups",
            rh["last_error"],
            **rh,
        )
    )
    out += await _subscription_rows(session)
    # Providers needing attention: a failed test/catalog fetch, a failed LiteLLM registration, a
    # rate limit or other cooldown (with the time it ends), or a provider near its free limit.
    registry = load_registry()
    cooling = cooldowns.active()
    view = await quota.load_view(session, registry)
    usage = {
        u["provider"]: u for u in quota.provider_summary(view, await connected_providers(session, registry))
    }
    rq = (await rules_versions.effective_rules(session)).quota
    conns = {c.provider: c for c in (await session.execute(select(Connection))).scalars()}
    for p in registry.providers.values():
        if p.kind == "cli":
            continue
        c = conns.get(p.id) or Connection(provider=p.id, kind=p.kind, status="unknown")
        cds = sorted(
            (
                cd
                for t, cd in cooling.items()
                if (cd.provider or t.removeprefix("model:").split("/")[0]) == p.id
            ),
            key=lambda cd: -cd.until,
        )
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
        elif cds:
            cd = cds[0]
            out.append(
                _c(
                    f"provider:{c.provider}",
                    "degraded",
                    None,
                    cd.reason,
                    name=p.name,
                    code=cd.code if cd.code in COOLDOWN_CODES else "cooldown",
                    until=cd.until_iso,
                )
            )
        elif (u := usage.get(c.provider)) and u["fraction"] >= rq.reroute_at:
            out.append(
                _c(
                    f"provider:{c.provider}",
                    "degraded",
                    None,
                    None,
                    name=p.name,
                    code="quota_high",
                    quota=u,
                    until=u["resets_at"],
                )
            )
    return out


async def _subscription_rows(session: AsyncSession) -> list[dict[str, Any]]:
    """One row per subscription account that has a reading or a run: its tightest usage window."""
    reg = await fleet.refresh(session)
    by_cli = {c: await accounts.names(session, c) for c in reg.clis}
    rows = []
    for a in await subscriptions.overview(session, reg, by_cli):
        t = a["tightest"]
        if t is None or (t["used"] is None and not t["runs"] and not t["seen_at"]):
            continue  # never used through Switchboard: nothing to say
        g = reg.defaults.guard
        status = "down" if t["limited"] else "degraded" if (t["used"] or 0) >= g.save_at else "ok"
        st = await accounts.status(a["cli"], a["account"])
        cli = reg.clis[a["cli"]]
        rows.append(
            _c(
                f"subscription:{a['cli']}:{a['account']}",
                status,
                None,
                None,
                name=cli.plan_label(st.get("plan")) if st.get("plan") else cli.label,
                account=a["account"],
                window=t,
                until=t["resets_at"],
            )
        )
    return rows


@router.post("/system/rollups/run", dependencies=[Depends(require_admin)])
async def run_rollups(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Status → Rollups "Catch up now": recompute every waiting bucket at once."""
    n = await rollup.drain(session)
    t = datetime.now(UTC).isoformat()
    await rollup._save_health(session, last_run_at=t, last_ok_at=t, last_count=n, last_error=None)
    return {"recomputed": n, **(await rollup.health(session))}


COOLDOWN_CODES = {"rate_limited", "credit_limit", "timeout", "error", "not_found", "not_connected"}


async def _local_rows(ollama_ok: bool) -> list[dict[str, Any]]:
    """`local_profile` row (detected GPU → profile, missing models) and the classifier's state."""
    state = local_profile.view(_profile_state, await ollama.tags() if ollama_ok else None)
    prof = next(p for p in state["profiles"] if p["name"] == state["active"])
    det = state["detected"]
    rows = [
        _c(
            "local_profile",
            "degraded" if state["missing"] else "ok",
            "pull_models" if state["missing"] and ollama_ok else None,
            None,
            profile=state["active"],
            label=prof["label"],
            vram_gb=det.get("vram_gb"),
            missing=state["missing"],
            overridden=state["overridden"],
        )
    ]
    if prof["classifier"]:
        missing = prof["classifier"] in state["missing"]
        paused = classifier.breaker.until > time.monotonic()
        rows.append(
            _c(
                "classifier",
                "degraded" if (missing or paused or not ollama_ok) else "ok",
                "pull_models" if missing and ollama_ok else None,
                classifier.breaker.reason if paused else None,
                code="classifier_missing" if missing else ("classifier_paused" if paused else None),
            )
        )
    return rows


_profile_state: dict[str, Any] = {}


async def refresh_profile_state(session: AsyncSession) -> dict[str, Any]:
    global _profile_state
    _profile_state = await local_profile.load_state(session)
    return _profile_state


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


@router.get("/system/summary")
async def summary(request: Request, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """The portal footer, polled every 60 s while visible: four health dots, today's spend and the
    value of free calls, quota status and the version. Probes are cached 15 s (`_reachable`)."""
    s = get_settings()
    litellm_up, (ollama_ok, _), (pc_status, _) = await asyncio.gather(
        request.app.state.litellm.alive(),
        _reachable("ollama", s.ollama_api_base.rstrip("/") + "/api/tags"),
        _paperclip(),
    )
    pc_ok = pc_status != "down"
    o = await user_settings.load(session)
    rules = await rules_versions.effective_rules(session)
    cap = float(o.get("daily_cap_usd", rules.defaults.daily_cap_usd))
    spent = await spent_today(session)
    cooling = cooldowns.active()
    registry = load_registry()
    view = await quota.load_view(session, registry)
    by_provider = quota.provider_summary(view, await connected_providers(session, registry))
    low, out = [], []
    for p in registry.providers.values():
        if credits.is_credits(p) and (c := await credits.status(session, p.id)):
            if c["exhausted"]:
                out.append(p.id)
            elif c["starting_usd"] and c["remaining_usd"] / c["starting_usd"] < 0.2:
                low.append(p.id)
    cap_used = spent / cap if cap > 0 else 1.0
    near = any(u["fraction"] >= rules.quota.reroute_at for u in by_provider)
    status = (
        "blocked"
        if cap_used >= 1
        else ("limited" if cooling or out or cap_used >= 0.8 or low or near else "ok")
    )
    return {
        "health": {
            "router": "ok",
            "litellm": "ok" if litellm_up else "down",
            "ollama": "ok" if ollama_ok else "down",
            "paperclip": "ok" if pc_ok else "down",
            "model_sync": sync.state.status,
        },
        "spend_today_usd": round(spent, 4),
        "value_saved_usd": round(await value_saved_today(session), 4),
        "quota": {
            "status": status,
            "daily_cap_usd": cap,
            "daily_cap_used": round(min(cap_used, 1.0), 3),
            "cooling_down": sorted(cooling),
            "credits_low": low,
            "credits_out": out,
            # M3a quota guard: the provider closest to a free limit, and all of them (Status view)
            "providers": by_provider,
            "top": by_provider[0] if by_provider and by_provider[0]["fraction"] >= 0.5 else None,
        },
        "version": request.app.version,
    }


# --- local models (M3a): Settings → Local models, Status "Pull models" --------------------------------
class ProfileIn(BaseModel):
    profile: str | None = Field(default=None, max_length=32)  # None = back to the detected one


async def _profile_view(session: AsyncSession) -> dict[str, Any]:
    state = await refresh_profile_state(session)
    installed = await ollama.tags()
    v = local_profile.view(state, installed)
    v["ollama"] = "ok" if installed is not None else "down"
    v["pull"] = dict(ollama.pull_state)
    return v


@router.get("/system/local-profile")
async def get_local_profile(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _profile_view(session)


@router.put("/system/local-profile", dependencies=[Depends(require_admin)])
async def put_local_profile(
    body: ProfileIn, session: AsyncSession = Depends(get_session), admin: LiteLLMAdmin = Depends(litellm)
) -> dict[str, Any]:
    try:
        await local_profile.choose(session, body.profile)
    except ValueError as e:
        raise problem(400, "bad_profile", "That profile doesn't exist.", str(e)) from None
    classifier.reset()
    try:  # the local aliases now point at the new profile's models
        await sync.sync_once(session, admin, "local-model profile changed")
    except Exception as e:
        sync.request("profile changed", None, str(e))
    return await _profile_view(session)


@router.post("/system/local-profile/detect", dependencies=[Depends(require_admin)])
async def redetect(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    await local_profile.init(session, redetect=True)
    return await _profile_view(session)


class PullIn(BaseModel):
    # M2.5: also (or only) the profile's vision model, which setup never pulls on its own
    vision: bool = False


@router.post("/system/models/pull", dependencies=[Depends(require_admin)])
async def pull_models(
    body: PullIn | None = None, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """Pull the active profile's missing models in the background (progress in GET local-profile). With
    `vision`, the profile's vision model too (for images in private chats)."""
    v = await _profile_view(session)
    if v["ollama"] != "ok":
        raise problem(503, "ollama_down", "Ollama isn't reachable. Start Ollama, then try again.", None)
    want = list(v["missing"])
    if body and body.vision and v.get("vision") and v.get("vision_installed") is False:
        want.append(v["vision"])
    if want and ollama.pull_state.get("status") != "running":
        task = asyncio.get_running_loop().create_task(ollama.pull(want))
        _pulls.add(task)
        task.add_done_callback(_pulls.discard)
    return {"started": bool(want), "missing": want, "pull": dict(ollama.pull_state)}


_pulls: set[asyncio.Task] = set()
