"""Workflow packs API (M4.5a, SPEC §8a, ADRs 0018-0019). Admin only.

The library lists every manifest in packs/ with what hostprobe has installed; installing is plan → confirm →
streamed log (hostprobe runs it from the pack's lock); every store action is recorded in `pack_installs`.
Per-project settings live under /projects/{id}/packs; graphify's measuring under /metrics/packs.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from app import db, fleet, hostprobe_client
from app.db import get_session
from app.deps import require_admin
from app.models import PackInstall, Project
from app.packs import registry
from app.packs import service as packs

log = logging.getLogger("app.api.packs")
router = APIRouter(tags=["packs"], dependencies=[Depends(require_admin)])
JOB_RE = re.compile(r"[\w-]{1,40}")
_plans: dict[str, tuple[float, dict[str, Any]]] = {}  # plan id -> the plan the owner read (5 minutes)


class RunIn(BaseModel):
    plan_id: str = Field(min_length=8, max_length=64)
    # Community packs need a second, explicit confirm ("I understand this pack is unverified").
    accept_unverified: bool = False


class ProjectPacksIn(BaseModel):
    packs: dict[str, dict[str, Any]] = Field(default_factory=dict, max_length=20)


def pack_json(p: registry.Pack, inst: dict[str, Any] | None) -> dict[str, Any]:
    inst = inst or {}
    return {
        "id": p.id,
        "name": p.name,
        "summary": p.summary,
        "trust": p.trust,
        "unverified": p.trust != "verified",
        "source": p.source,
        "kind": p.kind,
        "package": p.package,
        "version": p.version,
        "homepage": p.homepage,
        "repository": p.repository,
        "license": p.license,
        "hosts": sorted(p.hosts),
        "scope": list(p.scope),
        "refused": p.refused,
        "lock_problem": p.lock_problem,
        "installable": p.installable,
        "auto": p.auto,
        "flows": [{"id": f"{p.id}.{f.id}", "label": f.label, "summary": f.summary,
                   "steps": [s.label for s in f.steps]} for f in p.flows],
        "installed": inst.get("current"),
        "previous": inst.get("previous"),
        "update": bool(inst.get("current") and p.version and inst.get("current") != p.version),
        "verify": inst.get("verify"),
    }


async def _history(session: AsyncSession, pack: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    q = select(PackInstall).order_by(PackInstall.id.desc()).limit(limit)
    if pack:
        q = q.where(PackInstall.pack == pack)
    return [
        {
            "id": r.id,
            "pack": r.pack,
            "version": r.version,
            "action": r.action,
            "status": r.status,
            "summary": r.summary_json,
            "log_tail": r.log_tail,
            "started_at": r.started_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        }
        for r in (await session.scalars(q)).all()
    ]


@router.get("/packs")
async def library(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = registry.load()
    inst = await packs.installed(fresh=True)
    return {
        "packs": [pack_json(p, inst["packs"].get(p.id)) for p in sorted(reg.packs.values(), key=lambda x: x.name.lower())],
        "errors": reg.errors,
        "hostprobe": inst["reachable"],
        "hostprobe_error": inst.get("error"),
        "store": inst.get("store"),
        "network_isolated": inst.get("network_isolated"),
        "history": await _history(session),
    }


@router.get("/packs/{pack_id}/check")
async def check(pack_id: str) -> dict[str, Any]:
    """Re-hash the installed version now (the same check every job runs), with its time."""
    _installable(pack_id)
    status, data = await hostprobe_client.call("GET", "/packs?verify=1", timeout=60)
    if status != 200:
        raise HTTPException(503, data.get("error") or "hostprobe isn't answering")
    row = next((p for p in data.get("packs") or [] if p.get("id") == pack_id), None)
    if row is None or not row.get("current"):
        raise HTTPException(404, "not installed")
    return {"id": pack_id, "current": row["current"], "verify": row.get("verify")}


def _installable(pack_id: str) -> registry.Pack:
    pack = registry.load().get(pack_id)
    if pack is None:
        raise HTTPException(404, "no such pack")
    if pack.refused:
        raise HTTPException(403, pack.refused)
    if pack.lock_problem:
        raise HTTPException(409, f"{pack.name} can't be installed yet: {pack.lock_problem}")
    return pack


@router.post("/packs/{pack_id}/install-plan")
async def install_plan(pack_id: str) -> dict[str, Any]:
    """Step 1: everything the owner reads before confirming. Nothing is installed yet."""
    pack = _installable(pack_id)
    status, plan = await hostprobe_client.call("POST", f"/packs/{pack_id}/plan", timeout=30)
    if status != 200:
        raise HTTPException(status if status < 500 else 502, plan.get("error") or "couldn't plan the install")
    plan["unverified"] = pack.trust != "verified"
    plan["summary"] = pack.summary
    now = time.monotonic()
    for k in [k for k, (t, _) in _plans.items() if now - t > 300]:
        _plans.pop(k, None)
    if plan.get("plan_id"):
        _plans[plan["plan_id"]] = (now, plan)
    return plan


@router.post("/packs/{pack_id}/install")
async def install_run(pack_id: str, body: RunIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Step 2: run the plan the owner confirmed (single use). Returns a hostprobe job to stream."""
    pack = _installable(pack_id)
    if pack.trust != "verified" and not body.accept_unverified:
        raise HTTPException(400, f"{pack.name} is unverified: confirm that you accept it before installing")
    seen = _plans.pop(body.plan_id, None)
    status, job = await hostprobe_client.call("POST", f"/packs/{pack_id}/run", {"plan_id": body.plan_id})
    if status >= 400:
        raise HTTPException(status, str(job.get("error", "hostprobe error"))[:300])
    plan = seen[1] if seen else {}
    row = PackInstall(
        pack=pack_id,
        version=plan.get("version") or pack.version,
        action="install",
        status="running",
        hostprobe_job=str(job.get("id"))[:32],
        summary_json={k: plan.get(k) for k in (
            "source", "package", "version", "hash", "dependencies", "commands", "writes", "project_writes",
            "network_isolated", "unverified", "lookalikes", "current",
        )},
    )
    session.add(row)
    await session.commit()
    asyncio.get_running_loop().create_task(_watch(row.id, str(job.get("id"))))
    packs.forget_installed()
    return job


async def _watch(row_id: int, job_id: str) -> None:
    """Record how a hostprobe install job ended (and its last lines)."""
    deadline = time.monotonic() + 1200
    while time.monotonic() < deadline:
        await asyncio.sleep(2)
        status, snap = await hostprobe_client.call("GET", f"/packs/jobs/{job_id}", timeout=10)
        if status == 404:
            state, tail = "failed", "hostprobe restarted during the install"
        elif status != 200 or snap.get("state") == "running":
            continue
        else:
            state = "ok" if snap.get("state") == "ok" else "failed"
            tail = "\n".join(snap.get("tail") or [])[-4000:]
        try:
            async with db.sessionmaker()() as session:
                row = await session.get(PackInstall, row_id)
                if row is not None:
                    row.status, row.log_tail, row.finished_at = state, tail, datetime.now(UTC)
                    await session.commit()
        except Exception:  # noqa: BLE001 - a lost record must not crash the loop
            log.exception("pack install %s: record not updated", row_id)
        packs.forget_installed()
        return


@router.get("/packs/jobs/{job_id}")
async def install_job(job_id: str) -> dict[str, Any]:
    if not JOB_RE.fullmatch(job_id):
        raise HTTPException(404, "unknown job")
    status, data = await hostprobe_client.call("GET", f"/packs/jobs/{job_id}")
    if status != 200:
        raise HTTPException(status if status < 500 else 502, data.get("error") or "unknown job")
    return data


@router.get("/packs/jobs/{job_id}/events")
async def install_events(job_id: str, start: int = 0) -> StreamingResponse:
    if not JOB_RE.fullmatch(job_id):
        raise HTTPException(404, "unknown job")
    try:
        client, resp = await hostprobe_client.open_stream(f"/packs/jobs/{job_id}/events?from={max(start, 0)}")
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


async def _store_action(pack_id: str, action: str, session: AsyncSession) -> dict[str, Any]:
    pack = registry.load().get(pack_id)
    if pack is None:
        raise HTTPException(404, "no such pack")
    before = (await packs.installed(fresh=True))["packs"].get(pack_id) or {}
    status, data = await hostprobe_client.call("POST", f"/packs/{pack_id}/{action}", timeout=120)
    ok = status == 200
    session.add(
        PackInstall(
            pack=pack_id,
            version=(data.get("current") if action == "rollback" else before.get("current")) if ok else None,
            action=action,
            status="ok" if ok else "failed",
            summary_json={"from": before.get("current"), "to": data.get("current") if ok else None},
            log_tail=None if ok else str(data.get("error"))[:1000],
            finished_at=datetime.now(UTC),
        )
    )
    await session.commit()
    packs.forget_installed()
    if not ok:
        raise HTTPException(status if status < 500 else 502, data.get("error") or f"couldn't {action}")
    return data


@router.post("/packs/{pack_id}/rollback")
async def rollback(pack_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _store_action(pack_id, "rollback", session)


@router.post("/packs/{pack_id}/uninstall")
async def uninstall(pack_id: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Remove every installed version. Projects keep their settings; jobs then go without the pack."""
    return await _store_action(pack_id, "uninstall", session)


# --- per project ------------------------------------------------------------------------------------------
async def project_packs_json(session: AsyncSession, p: Project) -> dict[str, Any]:
    """A project's pack settings, with graphify's status line per group (Settings → Projects)."""
    st = packs.settings_of(p)
    cfg = packs.config()
    for pack_id, entry in st.items():
        if "mode" not in entry:
            continue
        groups = []
        for group, m in sorted((entry.get("measure") or {}).items()):
            rows = await packs.samples(session, p.id, group)
            this = [r for r in rows if r["round"] == int(m.get("round", 1))]
            counts = (sum(r["used"] for r in this), sum(not r["used"] for r in this))
            agent, _, flow = group.partition("|")
            groups.append({"group": group, "agent": agent, "flow": None if flow == "plain" else flow,
                           "state": m.get("state"), "status": packs.status_line(m, counts, cfg.measure),
                           "numbers": m.get("numbers")})
        entry["groups"] = groups
        entry["auto_threshold"] = {"min_files": cfg.min_files, "min_bytes": cfg.min_bytes}
        entry.pop("measure", None)
    return st


@router.get("/projects/{project_id}/packs")
async def get_project_packs(project_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    p = await session.get(Project, project_id)
    if p is None or p.removed_at is not None:
        raise HTTPException(404, "no such project")
    return {"project_id": p.id, "packs": await project_packs_json(session, p)}


@router.put("/projects/{project_id}/packs")
async def set_project_packs(
    project_id: int, body: ProjectPacksIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """Turn packs on or off for one project, and pick the agents (hosts) they are set up for."""
    await fleet.refresh(session)
    p = await session.get(Project, project_id)
    if p is None or p.removed_at is not None:
        raise HTTPException(404, "no such project")
    try:
        packs.update(p, body.packs)
    except packs.SettingsError as e:
        raise HTTPException(400, str(e)) from e
    await session.commit()
    return {"project_id": p.id, "packs": await project_packs_json(session, p)}


@router.get("/metrics/packs")
async def metrics_packs(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """graphify's measuring (ADR 0019): one row per project + agent + flow."""
    cfg = packs.config().measure
    return {
        "rows": await packs.metrics_rows(session),
        "measure": {"holdout_every": cfg.holdout_every, "min_samples": cfg.min_samples,
                    "min_gain": cfg.min_gain, "recheck_every": cfg.recheck_every},
    }
