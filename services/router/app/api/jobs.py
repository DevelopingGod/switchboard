"""Agent jobs API (M4a, ADR 0007). The UI comes in M4b.

POST /jobs                  start a job (agent chosen from the routing rule's chain, or named)
GET  /jobs                  newest first, keyset-paginated (?status=&limit=&before=)
GET  /jobs/{id}             the job and its timeline
GET  /jobs/{id}/events      SSE: `job` snapshots and the current run's `log` lines; resumable (Last-Event-ID)
GET  /jobs/{id}/diff        the job's changes against its base commit
POST /jobs/{id}/approve     {note}   plan / diff / result
POST /jobs/{id}/reject      {note}
POST /jobs/{id}/stop
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import db, hostprobe_client, jobs
from app.agents import load_agents
from app.config import get_settings
from app.db import get_session
from app.deps import require_admin
from app.models import Job, JobEvent, Project
from app.models import Request as RequestRow
from app.paperclip import Paperclip
from app.routing import secrets_detect
from app.routing.context import build_context
from app.routing.engine import RouteRequest, decide

router = APIRouter(tags=["jobs"], dependencies=[Depends(require_admin)])

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
MAX_STREAMS = 16
_streams = asyncio.Semaphore(MAX_STREAMS)


class JobIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=32_000)
    project_id: int
    agent: str | None = Field(default=None, max_length=64)
    autonomy: int | None = Field(default=None, ge=0, le=3)
    budget_list_usd: float | None = Field(default=None, gt=0, le=1000)
    title: str | None = Field(default=None, max_length=200)
    # The chat request this job came from ("Run as job"), for traceability.
    from_request_id: int | None = None


class DecisionIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)


def job_json(j: Job, events: list[JobEvent] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": j.id,
        "request_id": j.request_id,
        "project_id": j.project_id,
        "title": j.title,
        "prompt": j.prompt,
        "agent": j.agent,
        "agent_chain": j.agent_chain,
        "autonomy": j.autonomy,
        "status": j.status,
        "phase": j.phase,
        "gate": j.gate,
        "run_id": j.current_run_id,
        "worktree": None if j.worktree_removed else j.worktree_path,
        "branch": j.branch,
        "base_sha": j.base_sha,
        "budget_list_usd": float(j.budget_list_usd),
        "list_price_usd": round(float(j.list_price_usd or 0), 6),
        "cost_usd": round(float(j.cost_usd or 0), 6),
        "cost_reported": j.cost_reported,
        "turns": j.turns,
        "plan": j.plan_text,
        "result": j.result_text,
        "error": j.error,
        "paperclip": {
            "issue_id": j.paperclip_issue_id,
            "agent_id": j.paperclip_agent_id,
            "approval_id": j.paperclip_approval_id,
        },
        "created_at": j.created_at.isoformat(),
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
    }
    if events is not None:
        out["events"] = [
            {"id": e.id, "kind": e.kind, "at": e.created_at.isoformat(), **e.data} for e in events
        ]
    return out


async def _job(session: AsyncSession, job_id: int) -> Job:
    j = await session.get(Job, job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    return j


def _kick(job_id: int) -> None:
    """Advance a job now rather than at the next loop step (the loop still owns it; this is best effort)."""

    async def run() -> None:
        pc = Paperclip()
        try:
            await jobs.advance(job_id, pc)
        finally:
            await pc.aclose()

    if get_settings().background_jobs:
        asyncio.get_running_loop().create_task(run())


@router.post("/jobs", status_code=201)
async def create_job(body: JobIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    reg = load_agents()
    project = await session.get(Project, body.project_id)
    if project is None or project.removed_at is not None:
        raise HTTPException(400, "That project isn't on the Projects allowlist: add the folder first")
    masked, kinds = secrets_detect.mask(body.prompt)
    if kinds:
        raise HTTPException(
            400,
            "The task contains a secret (" + ", ".join(sorted(set(kinds))) + "). Agents run on cloud models: "
            "remove it and use an environment variable or a file the agent can read instead.",
        )
    if body.from_request_id is not None:
        src = await session.get(RequestRow, body.from_request_id)
        if src is None:
            raise HTTPException(404, "no such chat request")
        if src.private:
            raise HTTPException(
                400, "A private chat stays on this computer: it can't become a cloud agent job"
            )
    # The routing decision: which agents, in what order, at what autonomy (rules.yaml).
    ctx = await build_context(session)
    dec = decide(RouteRequest(text=masked, target="auto"), ctx)
    proposal = dec.as_dict().get("job") or {}
    if body.agent:
        if body.agent not in reg.agents:
            raise HTTPException(400, f"No agent called “{body.agent}” (config/agents.yaml)")
        chain = [body.agent]
    else:
        chain = [a["id"] for a in proposal.get("agents") or []] or [
            a.id for a in reg.agents.values() if a.runnable and "code" in a.capabilities
        ]
    autonomy = (
        body.autonomy if body.autonomy is not None else int(proposal.get("autonomy") or dec.autonomy or 1)
    )
    req = RequestRow(
        kind="job",
        prompt_hash=hashlib.sha256(masked.encode()).hexdigest(),
        rule_id=dec.rule_id,
        target=f"agent:{chain[0]}" if chain else None,
        autonomy=autonomy,
        intent=dec.intent,
        status="running",
        decision_json={
            **dec.as_dict(),
            "from_request_id": body.from_request_id,
            **({"tag": get_settings().router_request_tag} if get_settings().router_request_tag else {}),
        },
    )
    session.add(req)
    await session.flush()
    try:
        job = await jobs.create(
            session,
            prompt=masked,
            project=project,
            chain=chain,
            autonomy=autonomy,
            budget_list_usd=body.budget_list_usd,
            request_id=req.id,
            title=body.title,
        )
    except jobs.JobError as e:
        await session.rollback()
        raise HTTPException(e.status, e.message) from e
    _kick(job.id)
    return job_json(job)


@router.get("/jobs")
async def list_jobs(
    session: AsyncSession = Depends(get_session),
    status: str | None = Query(default=None, pattern="^(queued|running|needs_approval|done|failed|stopped)$"),
    limit: int = Query(default=50, ge=1, le=200),
    before: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    q = select(Job).order_by(Job.id.desc()).limit(limit + 1)
    if status:
        q = q.where(Job.status == status)
    if before:
        q = q.where(Job.id < before)
    rows = (await session.scalars(q)).all()
    page = rows[:limit]
    return {"jobs": [job_json(j) for j in page], "next": page[-1].id if len(rows) > limit else None}


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    j = await _job(session, job_id)
    events = (
        await session.scalars(
            select(JobEvent).where(JobEvent.job_id == j.id).order_by(JobEvent.id).limit(500)
        )
    ).all()
    return job_json(j, list(events))


@router.get("/jobs/{job_id}/diff")
async def get_diff(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    j = await _job(session, job_id)
    if not j.worktree_path or j.worktree_removed or not j.base_sha:
        raise HTTPException(404, "This job has no worktree (it made no changes, or its worktree was removed)")
    project = await session.get(Project, j.project_id)
    assert project is not None
    status, data = await hostprobe_client.call(
        "POST",
        "/git/worktrees/diff",
        {"project": project.path, "slug": project.slug, "job_id": j.id, "base": j.base_sha},
    )
    if status != 200:
        raise HTTPException(
            502 if status >= 500 else status, data.get("error") or "couldn't read the changes"
        )
    return data


async def _decide(job_id: int, approve: bool, body: DecisionIn, session: AsyncSession) -> dict[str, Any]:
    j = await _job(session, job_id)
    pc = Paperclip()
    try:
        await jobs.decide(session, pc, j, approve, body.note, by="you")
    except jobs.JobError as e:
        raise HTTPException(e.status, e.message) from e
    finally:
        await pc.aclose()
    await session.refresh(j)
    _kick(j.id)
    return job_json(j)


@router.post("/jobs/{job_id}/approve")
async def approve(
    job_id: int, body: DecisionIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    return await _decide(job_id, True, body, session)


@router.post("/jobs/{job_id}/reject")
async def reject(
    job_id: int, body: DecisionIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    return await _decide(job_id, False, body, session)


@router.post("/jobs/{job_id}/stop")
async def stop(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    j = await _job(session, job_id)
    pc = Paperclip()
    try:
        await jobs.stop(session, pc, j)
    finally:
        await pc.aclose()
    await session.refresh(j)
    return job_json(j)


def _sse(event: str, data: Any, eid: str | None = None) -> str:
    head = f"id: {eid}\n" if eid else ""
    return f"{head}event: {event}\ndata: {json.dumps(data)}\n\n"


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: int, request: Request, last_event_id: str | None = Header(default=None)
) -> StreamingResponse:
    """`job` (a snapshot whenever the job changes), `log` (the current run's output lines, id
    `log:<run>:<byte offset>` so a reconnect resumes where it stopped), `end` once the job is finished."""
    async with db.sessionmaker()() as session:
        await _job(session, job_id)
    if _streams.locked():
        raise HTTPException(429, "Too many job streams are open: close one and retry")
    resume_run, resume_at = None, 0
    if last_event_id and last_event_id.startswith("log:"):
        _, resume_run, at = (last_event_id.split(":", 2) + ["", ""])[:3]
        resume_at = int(at) if at.isdigit() else 0

    async def gen():
        async with _streams:
            pc = Paperclip()
            try:
                seen, run, offset = None, resume_run, resume_at
                while True:
                    if await request.is_disconnected():
                        return
                    async with db.sessionmaker()() as session:
                        j = await session.get(Job, job_id)
                    if j is None:
                        return
                    stamp = (j.updated_at, j.status, j.gate, j.current_run_id)
                    if stamp != seen:
                        seen = stamp
                        yield _sse("job", job_json(j))
                    if j.current_run_id and j.current_run_id != run:
                        run, offset = j.current_run_id, 0
                    if run:
                        page = await pc.run_log(run, offset=offset)
                        for line in page.lines:
                            yield _sse(
                                "log",
                                {
                                    "run": run,
                                    "stream": line.get("stream"),
                                    "chunk": line.get("chunk"),
                                    "ts": line.get("ts"),
                                },
                            )
                        if page.lines:
                            offset = page.next_offset
                            yield f"id: log:{run}:{offset}\n\n"
                    if j.status in jobs.TERMINAL and (not run or not page.lines):
                        yield _sse("end", {"status": j.status})
                        return
                    if not j.current_run_id and j.status != "running":
                        run = None
                    await asyncio.sleep(1)
            finally:
                await pc.aclose()

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
