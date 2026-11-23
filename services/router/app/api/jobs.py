"""Agent jobs API (M4a, ADR 0007; the page and fleet in M4b).

POST /jobs                  start a job (agents from the routing rule's chain, or named: `agent` or `agents`)
POST /jobs/preview          what that job would do, in plain words, without starting anything (M4b)
GET  /jobs                  newest first, keyset-paginated (?status=&agent=&project_id=&limit=&before=)
GET  /jobs/counts           jobs per status (same filters), for the board's tabs and the sidebar badge
GET  /jobs/proposal         the chat decision's job proposal for a request (?request_id=), for "Run as job"
GET  /jobs/{id}             the job and its timeline
GET  /jobs/{id}/runs        the job's runs (for the log picker)
GET  /jobs/{id}/log         one run's output, paged by byte offset (?run=&offset=)
GET  /jobs/{id}/events      SSE: `job` snapshots and the current run's `log` lines; resumable (Last-Event-ID)
GET  /jobs/{id}/diff        the job's changes against its base commit
POST /jobs/{id}/approve     {note}   plan / diff / result
POST /jobs/{id}/reject      {note}
POST /jobs/{id}/stop
POST /jobs/{id}/wait        M6.5: "Wait anyway" when the usage-limit reset is far away
POST /jobs/{id}/reroute     {agent}       M6.5: run a job waiting on a limit on another provider's agent
POST /jobs/{id}/paid        {budget_usd}  M6.5: use paid overflow for it (after "Paid — up to $X")
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import db, fleet, hostprobe_client, jobs
from app.agents import load_agents
from app.attachments import service as att_service
from app.config import get_settings
from app.db import get_session
from app.deps import require_admin
from app.models import Job, JobEvent, Project
from app.models import Request as RequestRow
from app.packs import service as packs_service
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
    # Primary agent first, then fallbacks (tried in order, only before the first run starts).
    agents: list[str] | None = Field(default=None, min_length=1, max_length=8)
    autonomy: int | None = Field(default=None, ge=0, le=3)
    budget_list_usd: float | None = Field(default=None, gt=0, le=1000)
    title: str | None = Field(default=None, max_length=200)
    # The chat request this job came from ("Run as job"), for traceability.
    from_request_id: int | None = None
    # M6.5 paid overflow: set only after you confirmed "Paid — up to $X" (ADR 0015).
    paid_budget_usd: float | None = Field(default=None, gt=0, le=1000)
    # M2.5: files for the agent (fresh uploads, or the chat message's files for "Run as job"). They are copied
    # into the job's worktree under a git-ignored .switchboard/attachments/ and never committed.
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    # M4.5a: a pack workflow, "<pack>.<flow>" (e.g. openspec.change); the project must have the pack on.
    flow: str | None = Field(default=None, max_length=64, pattern=r"^[a-z0-9-]{1,41}\.[a-z0-9-]{1,20}$")


class RerouteIn(BaseModel):
    agent: str = Field(min_length=1, max_length=64)


class PaidIn(BaseModel):
    budget_usd: float = Field(gt=0, le=1000)


class DecisionIn(BaseModel):
    note: str | None = Field(default=None, max_length=2000)
    # M4.5a: on the diff review, the setup edits you ticked (everything else a pack's setup changed stays out).
    include_setup_edits: list[str] = Field(default_factory=list, max_length=200)


def job_json(j: Job, events: list[JobEvent] | None = None, project: Project | None = None) -> dict[str, Any]:
    reg = load_agents()
    out: dict[str, Any] = {
        "id": j.id,
        "request_id": j.request_id,
        "project_id": j.project_id,
        "project": {"id": project.id, "name": project.name, "path": project.path} if project else None,
        "title": j.title,
        "prompt": j.prompt,
        "agent": j.agent,
        "agent_label": reg.label(j.agent),
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
        "account": j.account,
        "resume_at": j.resume_at.isoformat() if j.resume_at else None,
        "attempt": j.attempt or 0,
        "waits": j.waits or 0,
        "paid": bool(j.paid),
        "paid_budget_usd": float(j.paid_budget_usd) if j.paid_budget_usd is not None else None,
        "flow": j.flow,
        "flow_step": _flow_step(j),
        "packs": _packs_json(j),
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


def _flow_step(j: Job) -> dict[str, Any] | None:
    ref = packs_service.flow_ref(j.flow)
    if ref is None:
        return None
    pack, flow = ref
    i = min(j.run_index, len(flow.steps) - 1)
    return {
        "pack": pack.name,
        "label": flow.label,
        "index": i,
        "count": len(flow.steps),
        "step": flow.steps[i].label,
        "steps": [s.label for s in flow.steps],
    }


def _packs_json(j: Job) -> dict[str, Any] | None:
    """What the job page shows of its packs (never paths outside the worktree)."""
    p = j.packs or {}
    if not p:
        return None
    setup = p.get("setup") or {}
    return {
        "state": p.get("state"),
        "error": p.get("error"),
        "graphify": p.get("graphify"),
        "refused": setup.get("refused") or [],
        "packs": {
            k: {kk: v.get(kk) for kk in ("name", "version", "owned", "artifacts", "edits", "graph_stats", "verify_ms")}
            for k, v in (setup.get("packs") or {}).items()
        },
    }


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


async def _rule_of(body: JobIn, session: AsyncSession, dec: Any) -> str | None:
    """The routing rule behind the job ("light" vs heavy work, config/agents.yaml `subscription_guard`): the
    chat request's own rule for Run as job. A job started from New job has no rule: only its level counts."""
    if body.from_request_id is not None:
        src = await session.get(RequestRow, body.from_request_id)
        if src is not None and src.rule_id:
            return str(src.rule_id)
    return None


async def _resolve(body: JobIn, session: AsyncSession) -> tuple[Project, str, list[str], int, Any]:
    """The project, the masked task, the agent chain and the autonomy for a job, and the routing decision.
    Shared by create and preview, so the preview shows what create will do."""
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
    named = body.agents or ([body.agent] if body.agent else None)
    if named:
        unknown = [a for a in named if a not in reg.agents]
        if unknown:
            raise HTTPException(400, f"No agent called “{unknown[0]}” in the fleet")
        chain = list(dict.fromkeys(named))
    else:
        chain = [a["id"] for a in proposal.get("agents") or [] if a["id"] in reg.agents] or [
            a.id for a in reg.agents.values() if a.runnable and "code" in a.capabilities
        ]
    if body.autonomy is not None:
        autonomy = body.autonomy
    elif named and reg.agents[chain[0]].default_autonomy is not None:
        autonomy = int(reg.agents[chain[0]].default_autonomy or 0)
    else:
        autonomy = int(proposal.get("autonomy") or dec.autonomy or 1)
    allowed = [
        a
        for a in chain
        if reg.agents[a].allowed_projects is None or project.id in reg.agents[a].allowed_projects
    ]
    if chain and not allowed:
        raise HTTPException(
            400,
            "None of these agents may work in this project: allow it on the Agents page (Edit), "
            "or pick another agent",
        )
    return project, masked, chain, autonomy, dec


@router.post("/jobs/preview")
async def preview_job(body: JobIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    await fleet.refresh(session)
    project, _, chain, autonomy, dec = await _resolve(body, session)
    try:
        return await jobs.preview(
            session,
            project=project,
            chain=chain,
            autonomy=autonomy,
            budget_list_usd=body.budget_list_usd,
            rule_id=await _rule_of(body, session, dec),
            paid_budget_usd=body.paid_budget_usd,
            flow=body.flow,
        )
    except jobs.JobError as e:
        raise HTTPException(e.status, e.message) from e


@router.post("/jobs", status_code=201)
async def create_job(body: JobIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    await fleet.refresh(session)
    project, masked, chain, autonomy, dec = await _resolve(body, session)
    files = await att_service.for_job_request(session, body.attachment_ids)
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
            rule_id=await _rule_of(body, session, dec),
            paid_budget_usd=body.paid_budget_usd,
            files=files,
            flow=body.flow,
        )
    except jobs.JobError as e:
        await session.rollback()
        raise HTTPException(e.status, e.message) from e
    _kick(job.id)
    return job_json(job, project=project)


STATUS_PATTERN = "^(queued|running|needs_approval|waiting_reset|done|failed|stopped)$"


def _filtered(q: Any, agent: str | None, project_id: int | None) -> Any:
    if agent:
        q = q.where(Job.agent == agent)
    if project_id:
        q = q.where(Job.project_id == project_id)
    return q


@router.get("/jobs/counts")
async def job_counts(
    session: AsyncSession = Depends(get_session),
    agent: str | None = Query(default=None, max_length=64),
    project_id: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    rows = (
        await session.execute(
            _filtered(select(Job.status, func.count()).group_by(Job.status), agent, project_id)
        )
    ).all()
    counts = {st: 0 for st in (*jobs.ACTIVE, *jobs.TERMINAL)}
    counts.update({st: int(n) for st, n in rows})
    return {
        "counts": counts,
        "all": sum(counts.values()),
        "needs_you": counts["needs_approval"],
        "waiting": counts["waiting_reset"],
    }


@router.get("/jobs/proposal")
async def job_proposal(
    request_id: int = Query(ge=1), session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """What the routing rule proposed for a chat request: agents in order and an autonomy (never started
    by itself; "Run as job" shows it for you to change and confirm)."""
    reg = await fleet.refresh(session)
    req = await session.get(RequestRow, request_id)
    if req is None:
        raise HTTPException(404, "no such chat request")
    job = (req.decision_json or {}).get("job") or {}
    ids = [a["id"] for a in job.get("agents") or [] if a.get("id") in reg.agents]
    return {
        "request_id": req.id,
        "private": bool(req.private),
        "rule": req.rule_id,
        "suggested": bool(job.get("suggested")),
        "agents": ids,
        "autonomy": job.get("autonomy") if job.get("autonomy") is not None else req.autonomy,
    }


@router.get("/jobs")
async def list_jobs(
    session: AsyncSession = Depends(get_session),
    status: str | None = Query(default=None, pattern=STATUS_PATTERN),
    agent: str | None = Query(default=None, max_length=64),
    project_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    before: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    q = _filtered(select(Job).order_by(Job.id.desc()).limit(limit + 1), agent, project_id)
    if status:
        q = q.where(Job.status == status)
    if before:
        q = q.where(Job.id < before)
    rows = (await session.scalars(q)).all()
    page = rows[:limit]
    pids = {j.project_id for j in page}
    projects = (
        {p.id: p for p in (await session.scalars(select(Project).where(Project.id.in_(pids)))).all()}
        if pids
        else {}
    )
    return {
        "jobs": [job_json(j, project=projects.get(j.project_id)) for j in page],
        "next": page[-1].id if len(rows) > limit else None,
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    j = await _job(session, job_id)
    events = (
        await session.scalars(
            select(JobEvent).where(JobEvent.job_id == j.id).order_by(JobEvent.id).limit(500)
        )
    ).all()
    out = job_json(j, list(events), project=await session.get(Project, j.project_id))
    since = await jobs.waiting_since(session, j) if j.status == "needs_approval" else None
    hours = await jobs.approval_expiry_h(session)
    out["approval_expires_at"] = (
        (since + timedelta(hours=hours)).isoformat() if since is not None and hours else None
    )
    from app.models import Attachment

    out["attachments"] = [
        att_service.as_json(a)
        for a in (
            await session.scalars(
                select(Attachment).where(Attachment.job_id == j.id).order_by(Attachment.created_at)
            )
        ).all()
    ]
    return out


async def _runs(session: AsyncSession, job_id: int) -> list[dict[str, Any]]:
    evs = (
        await session.scalars(
            select(JobEvent)
            .where(JobEvent.job_id == job_id, JobEvent.kind.in_(("run_started", "run_finished")))
            .order_by(JobEvent.id)
            .limit(200)
        )
    ).all()
    runs: dict[str, dict[str, Any]] = {}
    for e in evs:
        rid = str(e.data.get("run") or "")
        if not rid:
            continue
        r = runs.setdefault(rid, {"run": rid, "kind": None, "started_at": None, "status": "running"})
        if e.kind == "run_started":
            r.update(
                kind=e.data.get("run_kind"), started_at=e.created_at.isoformat(), agent=e.data.get("agent")
            )
        else:
            r["status"] = e.data.get("status") or "succeeded"
    return list(runs.values())


@router.get("/jobs/{job_id}/runs")
async def job_runs(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    await _job(session, job_id)
    return {"runs": await _runs(session, job_id)}


@router.get("/jobs/{job_id}/log")
async def job_log(
    job_id: int,
    run: str = Query(min_length=1, max_length=64, pattern=r"^[\w-]+$"),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """One of the job's runs' output from `offset` (bytes), up to 256 KB per page: `next` is the offset to
    ask for next, or null at the end. Only runs of this job (Paperclip's run ids are not guessable, but the
    router still checks)."""
    await _job(session, job_id)
    if run not in {r["run"] for r in await _runs(session, job_id)}:
        raise HTTPException(404, "That run isn't part of this job")
    pc = Paperclip()
    try:
        page = await pc.run_log(run, offset=offset, limit_bytes=jobs.LOG_PAGE_BYTES)
    finally:
        await pc.aclose()
    lines = [{"stream": x.get("stream"), "chunk": x.get("chunk"), "ts": x.get("ts")} for x in page.lines]
    return {"run": run, "lines": lines, "next": page.next_offset if page.lines else None, "offset": offset}


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
        await jobs.decide(
            session, pc, j, approve, body.note, by="you", include_setup_edits=body.include_setup_edits
        )
    except jobs.JobError as e:
        raise HTTPException(e.status, e.message) from e
    finally:
        await pc.aclose()
    await session.refresh(j)
    _kick(j.id)
    return job_json(j, project=await session.get(Project, j.project_id))


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
    return job_json(j, project=await session.get(Project, j.project_id))


async def _limit_action(job_id: int, session: AsyncSession, action: Any) -> dict[str, Any]:
    j = await _job(session, job_id)
    await fleet.refresh(session)
    pc = Paperclip()
    try:
        await action(pc, j)
    except jobs.JobError as e:
        raise HTTPException(e.status, e.message) from e
    finally:
        await pc.aclose()
    await session.refresh(j)
    _kick(j.id)
    return job_json(j, project=await session.get(Project, j.project_id))


@router.post("/jobs/{job_id}/wait")
async def wait_anyway(job_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _limit_action(job_id, session, lambda pc, j: jobs.wait_anyway(session, pc, j))


@router.post("/jobs/{job_id}/reroute")
async def reroute(
    job_id: int, body: RerouteIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    return await _limit_action(job_id, session, lambda pc, j: jobs.reroute(session, pc, j, body.agent))


@router.post("/jobs/{job_id}/paid")
async def use_paid(job_id: int, body: PaidIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _limit_action(job_id, session, lambda pc, j: jobs.use_paid(session, pc, j, body.budget_usd))


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
