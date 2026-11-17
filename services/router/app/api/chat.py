"""Chat API (M2): threads, streamed turns (SSE), stop, feedback, picker targets, routing dry-run.

Every endpoint needs the admin token: chat history is private, and the portal calls these only from
its server (the browser never sees the token).
"""

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.dispatch import Fault
from app.config import get_settings
from app.db import get_session
from app.deps import litellm, require_admin
from app.litellm_admin import LiteLLMAdmin
from app.models import Message, ModelStats, Request, Thread
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

    def options(self) -> service.TurnOptions:
        fault = None
        if self.fault:
            if not get_settings().router_fault_injection:
                raise HTTPException(400, "fault injection is off (ROUTER_FAULT_INJECTION=1, dev only)")
            fault = Fault(self.fault.target, self.fault.kind)
        return service.TurnOptions(self.target, self.private, self.temperature, self.autonomy, fault)


class SendIn(TurnOptionsIn):
    thread_id: uuid.UUID | None = None
    text: str = Field(min_length=1, max_length=32_000)


class EditIn(TurnOptionsIn):
    text: str = Field(min_length=1, max_length=32_000)


class TitleIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)


class FeedbackIn(BaseModel):
    value: Literal["up", "down"] | None


class DryRunIn(BaseModel):
    text: str = Field(min_length=1, max_length=32_000)
    target: str = Field(default="auto", max_length=220, pattern=TARGET)
    private: bool = False


def _thread_json(t: Thread) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title or "New chat",
        "title_source": t.title_source,
        "private": t.private,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _message_json(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "role": m.role,
        "content": m.content,
        "status": m.status,
        "private": m.private,
        "feedback": {1: "up", -1: "down"}.get(m.feedback or 0),
        "route": m.meta_json or None,
        "created_at": m.created_at,
    }


def _stream(gen) -> StreamingResponse:
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


# --- threads ------------------------------------------------------------------------------------
@router.get("/chat/threads")
async def list_threads(session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    rows = (await session.execute(select(Thread).order_by(Thread.updated_at.desc()).limit(200))).scalars()
    return {"threads": [_thread_json(t) for t in rows]}


@router.get("/chat/threads/{thread_id}")
async def get_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    msgs = await service._messages(session, thread_id)
    return {"thread": _thread_json(t), "messages": [_message_json(m) for m in msgs]}


@router.patch("/chat/threads/{thread_id}")
async def rename_thread(
    thread_id: uuid.UUID, body: TitleIn, session: AsyncSession = Depends(get_session)
) -> dict[str, Any]:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    t.title, t.title_source = body.title.strip(), "user"
    await session.commit()
    return _thread_json(t)


@router.delete("/chat/threads/{thread_id}")
async def delete_thread(thread_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    await session.delete(t)
    await session.commit()
    return {"deleted": str(thread_id)}


# --- turns (SSE) --------------------------------------------------------------------------------
@router.post("/chat/send")
async def send(
    body: SendIn, session: AsyncSession = Depends(get_session), admin: LiteLLMAdmin = Depends(litellm)
) -> StreamingResponse:
    opts = body.options()
    prep = await service.prepare_turn(session, "send", body.thread_id, body.text, opts)
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
        if name == "private":  # same model as `local`; the Private switch is the way to use it
            continue
        deps = reg.alias(name)
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
                "test": None if e.p50_ms is None else {"p50_ms": e.p50_ms, "last_ok": True},
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
    ctx = await build_context(session)
    try:
        dec = decide(RouteRequest(text=body.text, target=body.target, private=body.private), ctx)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    first = dec.candidates[0] if dec.candidates else None
    return {
        **dec.as_dict(),
        "chosen": first.summary() if first else None,
        "reasons": reasons(dec, first, ctx.registry, ctx.catalog) if first else [],
        "runner_up": dec.candidates[1].label if len(dec.candidates) > 1 else None,
    }
