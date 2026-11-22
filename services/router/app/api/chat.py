"""Chat API (M2): threads, streamed turns (SSE), stop, feedback, picker targets, routing dry-run.

Every endpoint needs the admin token: chat history is private, and the portal calls these only from
its server (the browser never sees the token).
"""

import io
import json
import re
import uuid
import zipfile
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.attachments import service as att_service
from app.attachments import store as att_store
from app.chat import service
from app.chat.dispatch import Fault
from app.config import get_settings
from app.db import get_session
from app.deps import litellm, require_admin
from app.errors import rules_invalid
from app.litellm_admin import LiteLLMAdmin
from app.models import Message, ModelStats, Request, Thread
from app.routing import overrides, secrets_detect
from app.routing.context import build_context
from app.routing.engine import NON_CHAT_TAGS, RouteRequest, decide, reasons

router = APIRouter(tags=["chat"], dependencies=[Depends(require_admin)])

TARGET = r"^(auto|model:[\w.:/@-]{1,200})$"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class FaultIn(BaseModel):
    target: str = Field(max_length=220)
    kind: Literal["429", "timeout"]


class TurnOptionsIn(BaseModel):
    target: str = Field(default="auto", max_length=220, pattern=TARGET)
    private: bool = False
    temperature: float | None = Field(default=None, ge=0, le=2)
    autonomy: int | None = Field(default=None, ge=0, le=3)
    fault: FaultIn | None = None
    # M3a: "Not sensitive — use cloud" on an auto-private reply (regenerate only)
    cloud_override: bool = False
    # M4a: "Think harder" for this message: local answers use the profile's thinking model (`thinker`)
    think: bool = False

    def options(self) -> service.TurnOptions:
        fault = None
        if self.fault:
            if not get_settings().router_fault_injection:
                raise HTTPException(400, "fault injection is off (ROUTER_FAULT_INJECTION=1, dev only)")
            fault = Fault(self.fault.target, self.fault.kind)
        return service.TurnOptions(
            self.target, self.private, self.temperature, self.autonomy, fault, self.cloud_override, self.think
        )


class SendIn(TurnOptionsIn):
    thread_id: uuid.UUID | None = None
    # M2.5: an attachment-only message may have no text
    text: str = Field(default="", max_length=32_000)
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)


class EditIn(TurnOptionsIn):
    text: str = Field(min_length=1, max_length=32_000)


class ThreadPatch(BaseModel):
    """Rename and/or pin. At least one field."""

    title: str | None = Field(default=None, min_length=1, max_length=80)
    pinned: bool | None = None


class DeleteAllIn(BaseModel):
    confirm: Literal["delete all chats"]


class FeedbackIn(BaseModel):
    value: Literal["up", "down"] | None


class DryRunIn(BaseModel):
    text: str = Field(min_length=1, max_length=32_000)
    target: str = Field(default="auto", max_length=220, pattern=TARGET)
    private: bool = False
    think: bool = False
    # An unsaved Rules UI override document: test a change before saving it (never persisted).
    draft: dict[str, Any] | None = None


def _thread_json(t: Thread) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title or "New chat",
        "title_source": t.title_source,
        "private": t.private,
        "private_source": t.private_source if t.private else None,
        "pinned": t.pinned,
        "summary": t.summary_json or None,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _message_json(m: Message, atts: dict[int, list[Any]] | None = None) -> dict[str, Any]:
    files = (atts or {}).get(m.id) or []
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "status": m.status,
        "private": m.private,
        "feedback": {1: "up", -1: "down"}.get(m.feedback or 0),
        "route": (m.meta_json or None) if m.role == "assistant" else None,
        "secret": ((m.meta_json or {}).get("secret") or None) if m.role == "user" else None,
        "attachments": [att_service.as_json(a) for a in files] if m.role == "user" else [],
        "created_at": m.created_at,
    }


def _stream(gen) -> StreamingResponse:
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


# --- threads ------------------------------------------------------------------------------------
CURSOR = re.compile(r"^(\d{4}-\d\d-\d\dT[\d:.]+(?:[+-]\d\d:\d\d|Z)?)_([0-9a-f-]{36})$")


@router.get("/chat/threads")
async def list_threads(
    limit: int = Query(30, ge=1, le=100),
    cursor: str | None = Query(None, max_length=80),
    q: str | None = Query(None, max_length=80),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """The sidebar's recent chats (M3b), newest first, keyset-paginated on (updated_at, id) so deep pages
    cost the same as the first. Without `q` and `cursor`, `pinned` lists the pinned threads (at most 50)
    and `threads` holds the unpinned page. With `q`, every thread whose title contains it (case-insensitive)
    is matched, pinned or not, and `pinned` is empty. `next_cursor` is null on the last page."""
    searching = bool(q and q.strip())
    cond = []
    if searching:
        needle = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        cond.append(Thread.title.ilike(f"%{needle}%", escape="\\"))
    else:
        cond.append(Thread.pinned.is_(False))
    if cursor:
        m = CURSOR.match(cursor)
        if not m:
            raise HTTPException(400, "bad cursor")
        at, tid = datetime.fromisoformat(m.group(1)), uuid.UUID(m.group(2))
        cond.append(or_(Thread.updated_at < at, and_(Thread.updated_at == at, Thread.id < tid)))
    stmt = select(Thread).where(*cond).order_by(Thread.updated_at.desc(), Thread.id.desc()).limit(limit + 1)
    rows = list((await session.execute(stmt)).scalars())
    more = len(rows) > limit
    rows = rows[:limit]
    pinned: list[Thread] = []
    if not searching and not cursor:
        pinned = list(
            (
                await session.execute(
                    select(Thread)
                    .where(Thread.pinned.is_(True))
                    .order_by(Thread.updated_at.desc(), Thread.id.desc())
                    .limit(50)
                )
            ).scalars()
        )
    last = rows[-1] if more and rows else None
    return {
        "pinned": [_thread_json(t) for t in pinned],
        "threads": [_thread_json(t) for t in rows],
        "next_cursor": f"{last.updated_at.isoformat()}_{last.id}" if last else None,
    }


@router.delete("/chat/threads")
async def delete_all_threads(
    body: DeleteAllIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    """Settings → Data → Clear chats. Needs the literal confirmation phrase in the body."""
    n = (await session.execute(delete(Thread))).rowcount  # messages go with them (ON DELETE CASCADE)
    await session.commit()
    att_store.remove_all()  # and every chat's attachment files (M2.5)
    return {"deleted": n}


def _export_md(threads: list[tuple[Thread, list[Message]]], atts: dict[int, list[Any]]) -> str:
    out = ["# Switchboard chats", ""]
    for t, msgs in threads:
        out += [
            f"## {t.title or 'New chat'}",
            "",
            f"_{t.created_at:%Y-%m-%d %H:%M} UTC_" + (" · private" if t.private else ""),
            "",
        ]
        for m in msgs:
            who = "You" if m.role == "user" else "Assistant"
            via = (m.meta_json or {}).get("label") if m.role == "assistant" else None
            out += [f"**{who}**" + (f" ({via})" if via else ""), "", m.content or "", ""]
            for a in atts.get(m.id, []):
                out += [f"_Attached: {a.name} ({a.kind}, {a.bytes:,} bytes)_", ""]
    return "\n".join(out)


@router.get("/chat/export")
async def export_threads(
    format: Literal["json", "md"] = "json",
    include_private: bool = False,
    include_attachments: bool = False,
    session: AsyncSession = Depends(get_session),
):
    """Settings → Data → Export. Private threads only when asked for. Attachment files only when asked for
    (M2.5): then the answer is a .zip with the export and an `attachments/<thread id>/` folder per chat;
    otherwise the export lists each attachment's name, type and size."""
    q = select(Thread).order_by(Thread.created_at)
    if not include_private:
        q = q.where(Thread.private.is_(False))
    threads = [(t, await service._messages(session, t.id)) for t in (await session.execute(q)).scalars()]
    atts = await att_service.for_messages(
        session, [m.id for _, msgs in threads for m in msgs if m.role == "user"]
    )
    if format == "md":
        body: str | bytes = _export_md(threads, atts)
        name, media = "switchboard-chats.md", "text/markdown; charset=utf-8"
    else:
        body = json.dumps(
            {
                "format": "switchboard.chats.v1",
                "threads": [
                    {**_thread_json(t), "messages": [_message_json(m, atts) for m in msgs]}
                    for t, msgs in threads
                ],
            },
            default=str,
        )
        name, media = "switchboard-chats.json", "application/json"
    if not include_attachments:
        if format == "md":
            return PlainTextResponse(body, media_type=media)
        return Response(body, media_type=media)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, body)
        used: set[str] = set()
        for files in atts.values():
            for a in files:
                arc = f"attachments/{a.thread_id}/{a.name}"
                stem, dot, ext = a.name.rpartition(".")
                i = 1
                while arc in used:  # two files with one name in a chat
                    i += 1
                    arc = f"attachments/{a.thread_id}/{stem or a.name}-{i}{dot}{ext if dot else ''}"
                used.add(arc)
                try:
                    z.writestr(arc, att_service.blob_path(a).read_bytes())
                except FileNotFoundError:
                    continue
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="switchboard-chats.zip"'},
    )


@router.get("/chat/threads/{thread_id}")
async def get_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    msgs = await service._messages(session, thread_id)
    atts = await att_service.for_messages(session, [m.id for m in msgs if m.role == "user"])
    return {"thread": _thread_json(t), "messages": [_message_json(m, atts) for m in msgs]}


@router.patch("/chat/threads/{thread_id}")
async def update_thread(
    thread_id: uuid.UUID, body: ThreadPatch, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    if body.title is None and body.pinned is None:
        raise HTTPException(422, "nothing to change")
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    if body.title is not None:
        t.title, t.title_source = body.title.strip(), "user"
    if body.pinned is not None:
        t.pinned = body.pinned  # pinning does not touch updated_at: the thread keeps its date group
    await session.commit()
    return _thread_json(t)


@router.delete("/chat/threads/{thread_id}")
async def delete_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    await session.delete(t)
    await session.commit()
    att_store.remove_dir(att_store.thread_dir(thread_id))  # its attachments go with it (M2.5)
    return {"deleted": str(thread_id)}


# --- turns (SSE) --------------------------------------------------------------------------------
@router.post("/chat/send")
async def send(
    body: SendIn, session: AsyncSession = Depends(get_session), admin: LiteLLMAdmin = Depends(litellm)
) -> StreamingResponse:
    opts = body.options()
    if opts.cloud_override:
        raise HTTPException(422, "cloud_override is only for regenerate")
    if not body.text.strip() and not body.attachment_ids:
        raise HTTPException(422, "Type a message or attach a file.")
    prep = await service.prepare_turn(
        session, "send", body.thread_id, body.text, opts, attachment_ids=body.attachment_ids
    )
    return _stream(service.run_turn(admin.client, prep, opts))


@router.post("/chat/threads/{thread_id}/regenerate")
async def regenerate(
    thread_id: uuid.UUID,
    body: TurnOptionsIn,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> StreamingResponse:
    opts = body.options()
    prep = await service.prepare_turn(session, "regenerate", thread_id, None, opts)
    return _stream(service.run_turn(admin.client, prep, opts))


@router.post("/chat/threads/{thread_id}/edit-last")
async def edit_last(
    thread_id: uuid.UUID,
    body: EditIn,
    session: AsyncSession = Depends(get_session),
    admin: LiteLLMAdmin = Depends(litellm),
) -> StreamingResponse:
    opts = body.options()
    prep = await service.prepare_turn(session, "edit", thread_id, body.text, opts)
    return _stream(service.run_turn(admin.client, prep, opts))


@router.post("/chat/requests/{request_id}/stop")
async def stop(request_id: int) -> dict[str, Any]:
    ev = service.active.get(request_id)
    if ev is None:
        return {"stopped": False, "detail": "not streaming"}
    ev.set()
    return {"stopped": True}


@router.get("/chat/requests/{request_id}")
async def decision_log(request_id: int, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    r = await session.get(Request, request_id)
    if r is None:
        raise HTTPException(404, "request not found")
    return {
        "id": r.id,
        "kind": r.kind,
        "rule": r.rule_id,
        "intent": r.intent,
        "target": r.target,
        "model": r.model,
        "status": r.status,
        "private": r.private,
        "latency_ms": r.latency_ms,
        "ttft_ms": r.ttft_ms,
        "fallbacks_tried": r.fallbacks_tried_json,
        "decision": r.decision_json,
        "error": r.error,
        "created_at": r.created_at,
    }


# --- feedback (SPEC §6.4 learning; read by the M3 recommender) -----------------------------------
@router.post("/chat/messages/{message_id}/feedback")
async def feedback(
    message_id: int, body: FeedbackIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    m = await session.get(Message, message_id)
    if m is None or m.role != "assistant":
        raise HTTPException(404, "reply not found")
    new = {"up": 1, "down": -1, None: None}[body.value]
    old = m.feedback
    m.feedback = new
    req = await session.get(Request, m.request_id) if m.request_id else None
    if req and req.model_catalog_id and old != new:
        task = req.intent or "chat"
        stats = (
            await session.execute(
                select(ModelStats).where(
                    ModelStats.model_id == req.model_catalog_id, ModelStats.task_type == task
                )
            )
        ).scalar_one_or_none()
        if stats is None:
            stats = ModelStats(
                model_id=req.model_catalog_id,
                task_type=task,
                samples=0,
                failures=0,
                recent_ms=[],
                thumbs_up=0,
                thumbs_down=0,
            )
            session.add(stats)
        if old == 1:
            stats.thumbs_up = max(0, stats.thumbs_up - 1)
        elif old == -1:
            stats.thumbs_down = max(0, stats.thumbs_down - 1)
        if new == 1:
            stats.thumbs_up += 1
        elif new == -1:
            stats.thumbs_down += 1
    await session.commit()
    return {"message_id": message_id, "feedback": body.value}


# --- picker + dry run ---------------------------------------------------------------------------
@router.get("/chat/targets")
async def targets(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    ctx = await build_context(session)
    reg = ctx.registry
    aliases = []
    for name in dict.fromkeys(a.alias for a in reg.aliases):
        if name in ("private", "local-vision"):
            # `private` is the same model as `local` (the Private switch is the way to use it); `local-vision`
            # is picked automatically for images in a private chat (M2.5)
            continue
        deps = reg.alias(name)
        if deps and deps[0].dynamic:  # explore: chosen per request from the live catalog
            d = deps[0]
            p = reg.providers[d.provider]
            ok = d.provider in ctx.connected
            aliases.append(
                {
                    "target": f"model:{name}",
                    "alias": name,
                    "label": f"{p.name.split(' (')[0]} · best free model",
                    "available": ok,
                    "reason": None if ok else f"Add a key for {p.name} in Connections",
                    "local": False,
                    "free_tier": d.pick == "best-free",
                    "paid": p.paid and d.pick != "best-free",
                    "privacy": p.privacy,
                }
            )
            continue
        live = [d for d in deps if d.provider in ctx.connected]
        first = (live or deps)[0]
        p = reg.providers[first.provider]
        aliases.append(
            {
                "target": f"model:{name}",
                "alias": name,
                "label": f"{p.name.split(' (')[0]} · {first.model.split('/')[-1]}",
                "available": bool(live),
                "reason": None if live else f"Add a key for {p.name} in Connections",
                "local": all(reg.providers[d.provider].kind == "local" for d in deps),
                "free_tier": all(reg.providers[d.provider].is_free_tier(d.model) for d in (live or deps)),
                "paid": any(reg.providers[d.provider].paid for d in deps),
                "privacy": p.privacy,
            }
        )
    by_provider: dict[str, list[dict[str, Any]]] = {}
    for e in ctx.catalog:
        p = reg.providers.get(e.provider)
        if p is None or e.provider not in ctx.connected or p.kind == "cli":
            continue
        tags = list(e.tags)
        if NON_CHAT_TAGS & set(tags) or not ({"chat", "code", "reasoning"} & set(tags)):
            continue
        by_provider.setdefault(e.provider, []).append(
            {
                "target": f"model:{e.provider}/{e.model_id}",
                "provider": e.provider,
                "model_id": e.model_id,
                "display_name": e.display_name,
                "tags": tags,
                "tag_source": "curated",
                "context": e.context,
                "max_output": None,
                "free": p.is_free_tier(e.model_id),
                "paid": p.paid,
                "privacy": e.privacy,
                "status": "available",
                "test": None
                if e.p50_ms is None
                else {
                    "samples": None,
                    "error_rate": None,
                    "p50_ms": e.p50_ms,
                    "p95_ms": None,
                    "last_ok": True,
                },
            }
        )
    providers = [
        {
            "provider": pid,
            "name": reg.providers[pid].name,
            "local": reg.providers[pid].kind == "local",
            "privacy": reg.providers[pid].privacy,
            "models": sorted(models, key=lambda m: m["model_id"]),
        }
        for pid, models in sorted(by_provider.items())
    ]
    return {"aliases": aliases, "providers": providers, "preset": ctx.rules.preset}


@router.post("/route/dry-run")
async def dry_run(body: DryRunIn, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Which rule fires and which targets would be tried, without calling a model (M3 tester)."""
    try:
        ctx = await build_context(session, body.draft)
    except overrides.RulesInvalid as e:
        raise rules_invalid(e) from e
    masked, kinds = secrets_detect.mask(body.text)
    intent, cinfo = await service.classify_for(masked, ctx, body.private, bool(kinds))
    try:
        dec = decide(
            RouteRequest(
                text=masked,
                target=body.target,
                private=body.private and not kinds,
                classified=intent,
                classifier_info=cinfo,
                secret_kinds=tuple(kinds),
                think=body.think,
            ),
            ctx,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    first = dec.candidates[0] if dec.candidates else None
    return {
        **dec.as_dict(),
        "chosen": first.summary() if first else None,
        "reasons": reasons(dec, first, ctx.registry, ctx.catalog) if first else [],
        "runner_up": dec.candidates[1].label if len(dec.candidates) > 1 else None,
        "scores": [
            {"label": c.label, "score": c.scored.score, "proven": c.scored.proven, "parts": c.scored.parts}
            for c in dec.candidates
            if c.scored is not None
        ],
    }
