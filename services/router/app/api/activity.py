"""Activity log API (M2.5, ADR 0017): every request, newest first, filterable and searchable, with CSV.

Same range parameters as Metrics (`range`, `tz`, `first`, `last`, `include_demo`). Labels only, never message
text; private chats are "Private chat" and are never matched by the title search.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import db
from app.api.metrics import Common, common
from app.db import get_session
from app.deps import require_admin
from app.metrics import activity
from app.models import Job, Message
from app.models import Request as RequestRow

router = APIRouter(tags=["activity"], dependencies=[Depends(require_admin)])

NAME = r"^[\w.:/@ -]{1,200}$"


def filters(
    c: Common = Depends(common),
    kind: list[str] = Query(default_factory=list, max_length=5),
    model: str | None = Query(None, max_length=200, pattern=NAME),
    provider: str | None = Query(None, max_length=64, pattern=NAME),
    rule: str | None = Query(None, max_length=64, pattern=NAME),
    status: str | None = Query(None, max_length=16),
    q: str | None = Query(None, max_length=80),
) -> tuple[Common, activity.Filters]:
    if bad := [k for k in kind if k not in activity.KINDS]:
        raise HTTPException(400, f"unknown kind {bad[0]!r}")
    if status is not None and status not in activity.STATUSES:
        raise HTTPException(400, f"unknown status {status!r}")
    return c, activity.Filters(
        kinds=tuple(kind),
        model=model,
        provider=provider,
        rule=rule,
        status=status,
        q=(q or "").strip() or None,
        include_demo=c["demo"],
    )


@router.get("/activity")
async def list_activity(
    fc: tuple[Common, activity.Filters] = Depends(filters),
    cursor: str | None = Query(None, max_length=200, pattern=r"^[A-Za-z0-9_=-]{1,200}$"),
    limit: int = Query(activity.PAGE, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    c, f = fc
    out = await activity.page(session, c["r"], f, cursor, limit)
    return {"range": c["r"].as_dict(), **out}


@router.get("/activity/options")
async def activity_options(
    c: Common = Depends(common), session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    return {
        **await activity.options(session, c["r"]),
        "kinds": list(activity.KINDS),
        "statuses": list(activity.STATUSES),
    }


@router.get("/activity.csv")
async def activity_csv(fc: tuple[Common, activity.Filters] = Depends(filters)) -> StreamingResponse:
    c, f = fc
    r = c["r"]

    async def body():
        async with db.sessionmaker()() as s:  # its own session: the response outlives the request scope
            async for chunk in activity.csv_rows(s, r, f):
                yield chunk

    name = f"switchboard-activity-{r.key}-{r.last.isoformat()}.csv"
    return StreamingResponse(
        body(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/activity/{request_id}")
async def activity_detail(request_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """What "Why this?" shows for a row (the stored chip), or where the job lives. Never message text."""
    r = await session.get(RequestRow, request_id)
    if r is None:
        raise HTTPException(404, "request not found")
    if r.kind == "job":
        j = (await session.execute(select(Job.id).where(Job.request_id == r.id))).scalar_one_or_none()
        return {"id": r.id, "kind": "job", "job_id": j}
    msg = (
        await session.execute(select(Message).where(Message.request_id == r.id, Message.role == "assistant"))
    ).scalar_one_or_none()
    chip = (msg.meta_json if msg else None) or (r.decision_json or {}).get("chip") or {}
    return {
        "id": r.id,
        "kind": r.kind,
        "status": r.status,
        "rule": r.rule_id,
        "model": r.model,
        "latency_ms": r.latency_ms,
        "error": r.error,
        "route": {k: v for k, v in chip.items() if k not in ("content",)} or None,
    }
