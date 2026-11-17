"""Connections API (SPEC §8 Connections, §13.2): provider status, API keys, model tests, CLI status."""

import logging
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, SecretStr, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app import credits, hostprobe_client, model_test, secrets, sync
from app.catalog.fetchers import FetchError, fetch
from app.catalog.job import get_connection, record_fetch
from app.db import get_session
from app.deps import litellm, require_admin
from app.errors import classify, problem
from app.litellm_admin import LiteLLMAdmin, LiteLLMError
from app.models import Connection, ModelCatalog
from app.registry import Provider, load_registry, load_tag_rules

log = logging.getLogger("app.connections")
router = APIRouter(tags=["connections"])


class KeyIn(BaseModel):
    api_key: SecretStr = Field(min_length=8, max_length=512)


class CreditsIn(BaseModel):
    starting_usd: float = Field(ge=0, le=100_000)


class ModelTestIn(BaseModel):
    alias: str | None = None
    provider: str | None = None
    model_id: str | None = None

    @model_validator(mode="after")
    def one_target(self):
        if bool(self.alias) == bool(self.provider and self.model_id):
            raise ValueError("give either alias, or provider + model_id")
        return self


def _provider(provider_id: str, kinds: tuple[str, ...] = ("api_key",)) -> Provider:
    p = load_registry().get(provider_id)
    if p is None:
        raise HTTPException(404, f"unknown provider {provider_id}")
    if p.kind not in kinds:
        raise HTTPException(400, f"{provider_id} is a {p.kind} provider")
    return p


def _cli_rows(reachable: bool, data: dict[str, Any] | None, error: str | None) -> dict[str, dict[str, Any]]:
    clis = (data or {}).get("clis", {})
    rows = {}
    for p in load_registry().providers.values():
        if p.kind != "cli":
            continue
        c = clis.get(p.bin or "")
        if c is None:
            rows[p.id] = {
                "status": "unknown",
                "installed": None,
                "version": None,
                "logged_in": None,
                "windows_only": None,
                "error": error or "not reported by hostprobe",
            }
        else:
            status = (
                "logged_in"
                if c.get("logged_in")
                else "logged_out"
                if c.get("installed") and c.get("logged_in") is False
                else "installed"
                if c.get("installed")
                else "windows_only"
                if c.get("windows_only")
                else "not_installed"
            )
            rows[p.id] = {
                "status": status,
                **{
                    k: c.get(k)
                    for k in (
                        "installed",
                        "version",
                        "logged_in",
                        "windows_only",
                        "login_method",
                        "bin_path",
                        "bin_dir",
                        "on_user_path",
                    )
                },
            }
    return rows


@router.get("/connections")
async def list_connections(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    registry = load_registry()
    conns = {c.provider: c for c in (await session.execute(select(Connection))).scalars()}
    last4 = await secrets.key_last4(session)
    counts = dict(
        (
            await session.execute(
                select(ModelCatalog.provider, func.count())
                .where(ModelCatalog.status == "available")
                .group_by(ModelCatalog.provider)
            )
        ).all()
    )
    reachable, data, error = await hostprobe_client.probe()
    clis = _cli_rows(reachable, data, error)
    out = []
    for p in registry.providers.values():
        c = conns.get(p.id)
        row: dict[str, Any] = {
            "provider": p.id,
            "name": p.name,
            "kind": p.kind,
            "privacy": p.privacy,
            "paid": p.paid,
            "free_limits": p.free_limits,
            "notes": p.notes,
            "status": c.status if c else "unknown",
            "last_checked": c.last_checked if c else None,
            "last_error": c.last_error if c else None,
            "last_error_code": classify(c.last_error) if c else None,
        }
        if p.id in sync.state.provider_errors:
            # Registration in LiteLLM failed; the background sync is retrying. Shown with "Retry sync".
            row["sync_error"] = sync.state.provider_errors[p.id]
        if p.kind == "api_key":
            row["key_last4"] = last4.get(p.id)
        if credits.is_credits(p):
            row["credits"] = await credits.status(session, p.id) or {"starting_usd": None}
        if p.kind != "cli":
            row["models_available"] = counts.get(p.id, 0)
        else:
            row.update(clis[p.id])
            row["login_hint"] = p.login_hint
        out.append(row)
    return {"providers": out, "hostprobe": "up" if reachable else "down"}


async def _cli_status(fresh: bool = False) -> dict[str, Any]:
    reachable, data, error = await hostprobe_client.probe("/cli?fresh=1" if fresh else "/cli")
    return {
        "hostprobe": "up" if reachable else "down",
        "error": error,
        "clis": _cli_rows(reachable, data, error),
    }


@router.get("/connections/cli")
async def cli_status() -> dict[str, Any]:
    return await _cli_status()


@router.post("/connections/cli/refresh", dependencies=[Depends(require_admin)])
async def cli_refresh() -> dict[str, Any]:
    """The "Check again" button: bypasses hostprobe's 30 s cache (still rate limited there)."""
    return await _cli_status(fresh=True)


class InstallRunIn(BaseModel):
    plan_id: str = Field(min_length=8, max_length=128)


def _cli_bin(provider_id: str) -> str:
    return _provider(provider_id, ("cli",)).bin or ""


def _raise_probe(status: int, body: dict[str, Any]) -> dict[str, Any]:
    if status >= 400:
        raise HTTPException(status, str(body.get("error", "hostprobe error"))[:300])
    return body


@router.post("/connections/cli/{provider_id}/install-plan", dependencies=[Depends(require_admin)])
async def install_plan(provider_id: str) -> dict[str, Any]:
    """Step 1: the exact commands, source and hash for the user to read. Nothing is installed yet."""
    return _raise_probe(*await hostprobe_client.call("POST", f"/install/{_cli_bin(provider_id)}/plan"))


@router.post("/connections/cli/{provider_id}/install", dependencies=[Depends(require_admin)])
async def install_run(provider_id: str, body: InstallRunIn) -> dict[str, Any]:
    """Step 2: run the plan the user confirmed (single use). Returns a job to stream."""
    status, data = await hostprobe_client.call(
        "POST", f"/install/{_cli_bin(provider_id)}/run", {"plan_id": body.plan_id}
    )
    return _raise_probe(status, data)


@router.get("/connections/cli/jobs/{job_id}/events", dependencies=[Depends(require_admin)])
async def install_events(job_id: str, start: int = 0) -> StreamingResponse:
    if not job_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(404, "unknown job")
    try:
        client, resp = await hostprobe_client.open_stream(
            f"/install/jobs/{job_id}/events?from={max(start, 0)}"
        )
    except httpx.HTTPError:
        raise HTTPException(503, "hostprobe unreachable") from None
    if resp.status_code != 200:
        await resp.aread()
        await client.aclose()
        raise HTTPException(resp.status_code, "install job not found")

    async def close() -> None:
        await resp.aclose()
        await client.aclose()

    return StreamingResponse(
        resp.aiter_raw(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        background=BackgroundTask(close),
    )


@router.post("/connections/cli/jobs/{job_id}/cancel", dependencies=[Depends(require_admin)])
async def install_cancel(job_id: str) -> dict[str, Any]:
    if not job_id.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(404, "unknown job")
    return _raise_probe(*await hostprobe_client.call("POST", f"/install/jobs/{job_id}/cancel"))


@router.put("/connections/{provider_id}/key", dependencies=[Depends(require_admin)])
async def put_key(
    provider_id: str,
    body: KeyIn,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> dict[str, Any]:
    p = _provider(provider_id)
    key = body.api_key.get_secret_value().strip()
    secrets.remember(key)
    async with httpx.AsyncClient() as client:
        try:
            fetched = await fetch(client, p, key)  # validates the key before anything is stored
        except FetchError as e:
            raise problem(
                400,
                classify(str(e)) or "key_rejected",
                "The provider did not accept this key.",
                f"key test failed: {e}",
            ) from None
    await secrets.store_key(session, p.id, key)
    await session.commit()
    counts = await record_fetch(session, p, load_tag_rules(), fetched)
    try:
        changes = await sync.sync_once(session, admin, f"key saved ({p.id})")
    except (LiteLLMError, httpx.HTTPError) as e:
        sync.request("registration failed", p.id, str(e))
        raise problem(
            502,
            "gateway_sync",
            "Key saved. Couldn't sync with the model gateway; retrying automatically.",
            str(e),
        ) from None
    return {
        "provider": p.id,
        "status": "connected",
        "key_last4": key[-4:],
        "catalog": counts,
        "litellm": changes,
    }


@router.put("/connections/{provider_id}/credits", dependencies=[Depends(require_admin)])
async def put_credits(
    provider_id: str,
    body: CreditsIn,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> dict[str, Any]:
    """Enter (or reset) the starting credit balance; spend is counted from now. Re-syncs LiteLLM so
    a provider that was cut off at $0 is routable again."""
    p = _provider(provider_id)
    if not credits.is_credits(p):
        raise HTTPException(400, f"{provider_id} does not use credits")
    await credits.set_balance(session, p.id, body.starting_usd)
    await session.commit()
    try:
        await sync.sync_once(session, admin, f"credits changed ({p.id})")
    except (LiteLLMError, httpx.HTTPError) as e:
        sync.request("credits changed", p.id, str(e))
        raise problem(
            502,
            "gateway_sync",
            "Balance saved. Couldn't sync with the model gateway; retrying automatically.",
            str(e),
        ) from None
    return {"provider": p.id, "credits": await credits.status(session, p.id)}


@router.post("/connections/{provider_id}/resync", dependencies=[Depends(require_admin)])
async def resync_provider(
    provider_id: str,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> dict[str, Any]:
    """The card's "Retry sync" action, shown when registration failed. Reconciles the whole set now
    (idempotent)."""
    p = _provider(provider_id, ("api_key", "local"))
    try:
        changes = await sync.sync_once(session, admin, f"retry sync ({p.id})")
    except Exception as e:
        sync.request("retry sync failed", p.id, str(e))
        raise problem(
            502, "gateway_sync", "Couldn't sync with the model gateway. Retrying automatically.", str(e)
        ) from None
    return {"provider": p.id, "ok": True, "litellm": {k: len(v) for k, v in changes.items()}}


@router.post("/connections/{provider_id}/test", dependencies=[Depends(require_admin)])
async def test_connection(provider_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    p = _provider(provider_id, ("api_key", "local"))
    conn = await get_connection(session, p)
    key = await secrets.load_key(session, p.id) if p.kind == "api_key" else None
    if p.kind == "api_key" and key is None:
        raise HTTPException(400, f"no key stored for {p.id}")
    async with httpx.AsyncClient() as client:
        try:
            fetched = await fetch(client, p, key)
        except FetchError as e:
            conn.status, conn.last_error = "error", secrets.redact(str(e))
            conn.last_checked = datetime.now(UTC)
            await session.commit()
            return {"provider": p.id, "ok": False, "error": conn.last_error}
    counts = await record_fetch(session, p, load_tag_rules(), fetched)
    return {"provider": p.id, "ok": True, "catalog": counts}


@router.delete("/connections/{provider_id}/key", dependencies=[Depends(require_admin)])
async def delete_key(
    provider_id: str,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> dict[str, Any]:
    p = _provider(provider_id)
    removed = await secrets.delete_key(session, p.id)
    conn = await get_connection(session, p)
    conn.status, conn.last_error, conn.last_checked = "no_key", None, datetime.now(UTC)
    await session.commit()
    try:
        changes = await sync.sync_once(session, admin, f"key removed ({p.id})")
        await admin.delete_credential(p.id)
    except (LiteLLMError, httpx.HTTPError) as e:
        sync.request("key removed", p.id, str(e))
        raise problem(
            502,
            "gateway_sync",
            "Key removed. Couldn't sync with the model gateway; retrying automatically.",
            str(e),
        ) from None
    return {"provider": p.id, "removed": removed, "status": "no_key", "litellm": changes}


@router.post("/models/test", dependencies=[Depends(require_admin)])
async def test_model(
    body: ModelTestIn,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> dict[str, Any]:
    registry = load_registry()
    start = model_test.timer()
    if body.alias:
        deps = [d for d in registry.aliases if d.alias == body.alias]
        if not deps:
            raise HTTPException(404, f"unknown alias {body.alias}")
        try:
            served = await admin.chat(body.alias)
            ok, error = True, None
        except LiteLLMError as e:
            served, ok, error = None, False, secrets.redact(str(e))
        ms = model_test.elapsed_ms(start)
        first = sorted(deps, key=lambda d: d.order or 0)[0]
        await model_test.record(session, first.provider, first.model, ok, ms, error)
        return {"alias": body.alias, "ok": ok, "latency_ms": ms, "served_by": served, "error": error}

    p = _provider(body.provider or "", ("api_key", "local"))
    key = await secrets.load_key(session, p.id) if p.kind == "api_key" else None
    if p.kind == "api_key" and key is None:
        raise HTTPException(400, f"no key stored for {p.id}")
    async with httpx.AsyncClient() as client:
        try:
            await model_test.call_provider(client, p, body.model_id or "", key)
            ok, error = True, None
        except model_test.ModelTestError as e:
            ok, error = False, str(e)
    ms = model_test.elapsed_ms(start)
    await model_test.record(session, p.id, body.model_id or "", ok, ms if ok else None, error)
    return {"provider": p.id, "model_id": body.model_id, "ok": ok, "latency_ms": ms, "error": error}
