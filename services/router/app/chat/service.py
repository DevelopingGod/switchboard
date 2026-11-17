"""One chat turn: persist, route, stream, log (SPEC §7.1, §9, §13.5-6).

prepare_turn() runs inside the request (so 404/409 are real HTTP errors) and writes the user side;
run_turn() is the SSE body: decide → dispatch → finalize (requests, costs, model_stats, message).
A client disconnect or POST /chat/requests/{id}/stop ends the turn as `stopped`, keeping the
partial answer. Thinking text is streamed but never stored.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import credits, db, model_test, secrets
from app.chat.dispatch import (
    Delta,
    Exhausted,
    Failed,
    Fallback,
    Fault,
    Route,
    Served,
    Stopped,
    Thinking,
    Usage,
    dispatch,
)
from app.litellm_admin import LiteLLMAdmin
from app.models import Cost, Message, Request, Thread
from app.reconcile import reconcile
from app.registry import Registry
from app.routing.context import build_context
from app.routing.engine import (
    Candidate,
    CatalogEntry,
    Context,
    Decision,
    RouteRequest,
    decide,
    reasons,
    tokens,
)

log = logging.getLogger("app.chat")

SYSTEM_PROMPT = (
    "You are the assistant inside Switchboard, a personal AI portal. Answer clearly and concisely. "
    "Use Markdown. Put code in fenced blocks with a language tag."
)
TITLE_TARGET = "ollama/llama3.2:3b"  # local, no "thinking" output; titles never leave the machine
TITLE_TIMEOUT_S = 20
TITLE_WORDS = 6

# request id -> cancel flag (POST /chat/requests/{id}/stop); one router process
active: dict[int, asyncio.Event] = {}


@dataclass
class TurnOptions:
    target: str = "auto"
    private: bool = False
    temperature: float | None = None
    autonomy: int | None = None
    fault: Fault | None = None


@dataclass
class Prep:
    thread_id: uuid.UUID
    user_message_id: int
    user_text: str
    history: list[dict[str, str]]
    private: bool
    title: str
    title_pending: bool  # first turn: try a local summary title after the reply
    new_thread: bool
    extra: dict[str, Any] = field(default_factory=dict)


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def words_title(text: str) -> str:
    text = re.sub(r"^/\w+\s*", "", text.strip())
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)
    words = re.sub(r"\s+", " ", text).strip().split(" ")
    title = " ".join(words[:TITLE_WORDS]).strip(" .,:;-")
    if len(words) > TITLE_WORDS:
        title += "…"
    return title[:80] or "New chat"


def clean_title(raw: str) -> str | None:
    line = next((ln for ln in raw.strip().splitlines() if ln.strip()), "")
    line = re.sub(r"^(title\s*:\s*)", "", line.strip(), flags=re.I).strip(" \"'*#.`")
    n = len(line.split())
    if not line or n > 10 or len(line) > 80 or "<think>" in line:
        return None
    return line


def history_for(messages: list[Message]) -> list[dict[str, str]]:
    out = []
    for m in messages:
        if m.role == "user" or (m.role == "assistant" and m.status in ("done", "stopped") and m.content):
            out.append({"role": m.role, "content": m.content})
    return out


def trim_history(history: list[dict[str, str]], max_tokens: int) -> list[dict[str, str]]:
    """Newest first until the budget is used (SPEC §8c: send only what the task needs)."""
    kept: list[dict[str, str]] = []
    used = 0
    for m in reversed(history):
        t = tokens(len(m["content"]))
        if used + t > max_tokens:
            break
        kept.append(m)
        used += t
    return list(reversed(kept))


async def _thread(session: AsyncSession, thread_id: uuid.UUID) -> Thread:
    t = await session.get(Thread, thread_id)
    if t is None:
        raise HTTPException(404, "thread not found")
    return t


async def _messages(session: AsyncSession, thread_id: uuid.UUID) -> list[Message]:
    q = select(Message).where(Message.thread_id == thread_id).order_by(Message.id)
    return list((await session.execute(q)).scalars())


async def prepare_turn(
    session: AsyncSession, mode: str, thread_id: uuid.UUID | None, text: str | None, opts: TurnOptions
) -> Prep:
    new_thread = False
    if mode == "send":
        if thread_id is None:
            thread = Thread(private=opts.private)
            session.add(thread)
            await session.flush()
            new_thread = True
        else:
            thread = await _thread(session, thread_id)
        if active_in(thread.id):
            raise HTTPException(409, "a reply is still streaming in this thread")
        msgs = await _messages(session, thread.id)
        history = history_for(msgs)
        user = Message(
            thread_id=thread.id, role="user", content=text or "", private=opts.private or thread.private
        )
        session.add(user)
    else:
        thread = await _thread(session, thread_id)  # type: ignore[arg-type]
        if active_in(thread.id):
            raise HTTPException(409, "a reply is still streaming in this thread")
        msgs = await _messages(session, thread.id)
        users = [m for m in msgs if m.role == "user"]
        if not users:
            raise HTTPException(409, "nothing to regenerate yet")
        user = users[-1]
        if mode == "edit":
            user.content = text or ""
        later = [m.id for m in msgs if m.id > user.id]
        if later:
            await session.execute(delete(Message).where(Message.id.in_(later)))
        history = history_for([m for m in msgs if m.id < user.id])
    if opts.private:
        thread.private = True
    title_pending = thread.title_source == "none"
    if title_pending:
        thread.title, thread.title_source = words_title(user.content), "words"
    thread.updated_at = datetime.now(UTC)
    await session.commit()
    return Prep(
        thread_id=thread.id,
        user_message_id=user.id,
        user_text=user.content,
        history=history,
        private=thread.private or opts.private,
        title=thread.title,
        title_pending=title_pending,
        new_thread=new_thread,
    )


def active_in(thread_id: uuid.UUID) -> bool:
    return any(k[1] == thread_id for k in _threads_active)


_threads_active: set[tuple[int, uuid.UUID]] = set()


# --- cost bookkeeping ----------------------------------------------------------------------------
def served_model(registry: Registry, served: str | None, cand: Candidate) -> tuple[str, str]:
    """(provider, model_id) of the deployment that answered."""
    if served:
        p = registry.provider_for_litellm_model(served)
        if p is None and cand.provider in registry.providers:
            p = registry.providers[cand.provider]
        if p is not None:
            prefix = f"{p.litellm_prefix}/"
            return p.id, served[len(prefix) :] if served.startswith(prefix) else served
    if cand.litellm_model.startswith(f"{cand.provider}/"):
        return cand.provider, cand.litellm_model.split("/", 1)[1]
    first = registry.alias(cand.litellm_model)
    return (first[0].provider, first[0].model) if first else (cand.provider, cand.litellm_model)


def priced(entry: CatalogEntry | None, tin: int, tout: int) -> float | None:
    if not entry or (entry.input_per_1m is None and entry.output_per_1m is None):
        return None
    return tin * (entry.input_per_1m or 0) / 1e6 + tout * (entry.output_per_1m or 0) / 1e6


# --- the turn ------------------------------------------------------------------------------------
async def run_turn(client: httpx.AsyncClient, prep: Prep, opts: TurnOptions) -> AsyncIterator[str]:
    async with db.sessionmaker()() as s:
        ctx = await build_context(s)
        hist_chars = sum(len(m["content"]) for m in prep.history)
        dec = decide(
            RouteRequest(
                text=prep.user_text,
                target=opts.target,
                private=prep.private,
                temperature=opts.temperature,
                autonomy=opts.autonomy,
                context_chars=hist_chars,
            ),
            ctx,
        )
        history = trim_history(prep.history, ctx.rules.defaults.max_context_tokens)
        dec.context_tokens = tokens(sum(len(m["content"]) for m in history)) if history else 0
        thread = await s.get(Thread, prep.thread_id)
        assert thread is not None
        if dec.private and not thread.private:
            thread.private = True  # sticky: later requests in this thread stay local too
            user = await s.get(Message, prep.user_message_id)
            if user:
                user.private = True
        req = Request(
            kind="media" if dec.media else "chat",
            prompt_hash=hashlib.sha256(dec.prompt.encode()).hexdigest(),
            rule_id=dec.rule_id,
            intent=dec.intent,
            private=dec.private,
            temperature=dec.temperature,
            autonomy=dec.autonomy,
            status="running",
            thread_id=prep.thread_id,
            decision_json=dec.as_dict(),
        )
        s.add(req)
        await s.flush()
        asst = Message(
            thread_id=prep.thread_id,
            role="assistant",
            status="streaming",
            request_id=req.id,
            private=dec.private,
        )
        s.add(asst)
        await s.commit()
        start = {
            "thread_id": prep.thread_id,
            "user_message_id": prep.user_message_id,
            "message_id": asst.id,
            "request_id": req.id,
            "private": dec.private,
            "title": prep.title,
            "rule": dec.rule_id,
            "job_suggested": dec.job_suggested,
        }
        yield sse("start", start)

        if dec.media or not dec.candidates:
            async for ev in _no_dispatch(s, ctx, dec, req, asst, thread):
                yield ev
            return

        _threads_active.add((req.id, prep.thread_id))
        cancel = active.setdefault(req.id, asyncio.Event())
        st = _TurnState()
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": dec.prompt},
        ]
        try:
            async for ev in dispatch(client, dec, messages, cancel, ctx.cooldowns, opts.fault):
                for out in st.on(ev, ctx):
                    yield out
                if isinstance(ev, Fallback):
                    await _record_failure(s, ctx, ev.skip.target, dec)
        except Stopped:
            st.status = "stopped"
        except (asyncio.CancelledError, GeneratorExit):
            st.status = "stopped"
            await asyncio.shield(_finalize(s, ctx, dec, req, asst, thread, st))
            raise
        finally:
            active.pop(req.id, None)
            _threads_active.discard((req.id, prep.thread_id))
        meta = await _finalize(s, ctx, dec, req, asst, thread, st)
        if st.credits_used_up:
            await _drop_exhausted(s, client, st.credits_used_up)
        yield sse(
            "done", {"message_id": asst.id, "status": asst.status, "content": asst.content, "route": meta}
        )

        if prep.title_pending and asst.status == "done":
            title = await local_title(client, ctx, prep.user_text, asst.content)
            if title:
                thread.title, thread.title_source = title, "local"
                await s.commit()
                yield sse("title", {"thread_id": prep.thread_id, "title": title, "source": "local"})


class _TurnState:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()
        self.chosen: Candidate | None = None
        self.served: str | None = None
        self.usage: dict[str, Any] | None = None
        self.parts: list[str] = []
        self.ttft_ms: int | None = None
        self.think_t0: float | None = None
        self.think_ms: int | None = None
        self.status = "ok"
        self.error: str | None = None
        self.credits_used_up: str | None = None  # a credits provider whose balance this call emptied

    def ms(self) -> int:
        return int((time.perf_counter() - self.t0) * 1000)

    def on(self, ev: object, ctx: Context) -> list[str]:
        if isinstance(ev, Route):
            self.chosen, self.served, self.usage = ev.candidate, None, None
            c = ev.candidate
            return [
                sse(
                    "route",
                    {"target": c.target, "label": c.label, "local": c.local, "free_tier": c.free_tier},
                )
            ]
        if isinstance(ev, Fallback):
            self.think_t0 = None
            nxt = ev.next.label if ev.next else None
            return [sse("fallback", {**ev.skip.as_dict(), "next": nxt})]
        if isinstance(ev, Thinking):
            if self.think_t0 is None:
                self.think_t0 = time.perf_counter()
            return [sse("thinking", {"text": ev.text})]
        if isinstance(ev, Delta):
            if self.ttft_ms is None:
                self.ttft_ms = self.ms()
            if self.think_t0 is not None and self.think_ms is None:
                self.think_ms = int((time.perf_counter() - self.think_t0) * 1000)
            self.parts.append(ev.text)
            return [sse("delta", {"text": ev.text})]
        if isinstance(ev, Served):
            self.served = ev.model
        elif isinstance(ev, Usage):
            self.usage = ev.usage
        elif isinstance(ev, Failed):
            self.status, self.error = "error", ev.reason
        elif isinstance(ev, Exhausted):
            self.status, self.chosen = "failed", None
            self.error = "Every model in the chain failed or was skipped"
        return []


async def _drop_exhausted(s: AsyncSession, client: httpx.AsyncClient, provider: str) -> None:
    """A credits provider just hit $0: take its deployments out of LiteLLM so nothing routes there."""
    try:
        await reconcile(s, LiteLLMAdmin(client))
        log.info("credits used up for %s; its LiteLLM deployments were removed", provider)
    except Exception as e:  # the router-side check already blocks it; LiteLLM is re-synced on restart
        log.warning("could not drop %s from LiteLLM (%s)", provider, secrets.redact(str(e))[:160])


async def _record_failure(s: AsyncSession, ctx: Context, target: str, dec: Decision) -> None:
    cand = next((c for c in dec.candidates if c.target == target), None)
    skip = next((k for k in reversed(dec.skipped) if k.target == target), None)
    if cand is None:
        return
    provider, model_id = served_model(ctx.registry, None, cand)
    await model_test.record(
        s, provider, model_id, False, None, skip.reason if skip else None, task_type=dec.intent, commit=False
    )


async def _no_dispatch(s, ctx: Context, dec: Decision, req: Request, asst: Message, thread: Thread):
    """Media (Studio, M5), budget blocks and "nothing available" end here without a model call."""
    if dec.media:
        req.status, asst.status = "unavailable", "notice"
        asst.meta_json = {"notice": dec.media, **_chip(ctx, dec, None, None)}
        event = sse("notice", {"kind": dec.media, "message_id": asst.id})
    elif dec.blocked_by_budget:
        skip = next(k for k in dec.skipped if k.code.startswith("budget"))
        req.status, asst.status, req.error = "blocked", "blocked", skip.reason
        asst.content = ""
        block = {
            "code": skip.code,
            "reason": skip.reason,
            "daily_cap_usd": dec.daily_cap_usd,
            "max_cost_usd": dec.max_cost_usd,
            "spent_today": round(dec.spent_today, 4),
        }
        asst.meta_json = {"blocked": block, **_chip(ctx, dec, None, None)}
        event = sse("blocked", {**block, "message_id": asst.id})
    else:
        req.status, asst.status = "failed", "error"
        req.error = "No model is available for this request"
        asst.meta_json = {"error": req.error, **_chip(ctx, dec, None, None)}
        event = sse(
            "error",
            {"message": req.error, "message_id": asst.id, "skipped": [k.as_dict() for k in dec.skipped]},
        )
    req.fallbacks_tried_json = [k.as_dict() for k in dec.skipped]
    req.decision_json = {**dec.as_dict(), "chosen": None}
    thread.updated_at = datetime.now(UTC)
    await s.commit()
    yield event
    yield sse(
        "done",
        {"message_id": asst.id, "status": asst.status, "content": asst.content, "route": asst.meta_json},
    )


def _chip(ctx: Context, dec: Decision, chosen: Candidate | None, st: _TurnState | None) -> dict[str, Any]:
    """What the RouteChip / "Why this?" popover shows (stored on the message)."""
    runner = None
    if chosen:
        later = [c for c in dec.candidates if c.position >= chosen.position and c.target != chosen.target]
        runner = later[0].label if later else None
    return {
        "request_id": None,
        "rule": dec.rule_id,
        "matched_by": dec.matched_by,
        "intent": dec.intent,
        "preset": dec.preset,
        "private": dec.private,
        "job_suggested": dec.job_suggested,
        "target": chosen.target if chosen else None,
        "label": chosen.label if chosen else None,
        "local": chosen.local if chosen else None,
        "free_tier": chosen.free_tier if chosen else None,
        "reasons": reasons(dec, chosen, ctx.registry, ctx.catalog) if chosen else [],
        "runner_up": runner,
        "skipped": [k.as_dict() for k in dec.skipped],
        "context_tokens": dec.context_tokens,
        "thinking_ms": st.think_ms if st else None,
    }


async def _finalize(
    s: AsyncSession, ctx: Context, dec: Decision, req: Request, asst: Message, thread: Thread, st: _TurnState
) -> dict[str, Any]:
    text = "".join(st.parts).strip()
    latency = st.ms()
    chip = _chip(ctx, dec, st.chosen, st)
    chip["request_id"] = req.id
    if st.chosen is not None:
        provider, model_id = served_model(ctx.registry, st.served, st.chosen)
        entry = ctx.entry(provider, model_id)
        p = ctx.registry.providers.get(provider)
        u = st.usage or {}
        estimated = not u
        tin = int(u.get("prompt_tokens") or 0) or tokens(len(dec.prompt)) + dec.context_tokens
        tout = int(u.get("completion_tokens") or 0) or (tokens(len(text)) if text else 0)
        list_price = u.get("cost")
        if list_price is None:
            list_price = priced(entry, tin, tout)
        free = bool(p and p.is_free_tier(model_id)) or st.chosen.local
        cost = 0.0 if free else float(list_price or 0)
        s.add(
            Cost(
                request_id=req.id,
                source="litellm",
                provider=provider,
                model=st.served or st.chosen.litellm_model,
                tokens_in=tin,
                tokens_out=tout,
                cost_usd=cost,
                list_price_usd=list_price,
            )
        )
        if credits.is_credits(p):
            await s.flush()  # the new cost row counts toward the balance
            if (cs := await credits.status(s, p.id)) and cs["exhausted"]:
                st.credits_used_up = p.id
        req.target, req.model = st.chosen.target, st.served or st.chosen.litellm_model
        req.model_catalog_id = entry.id if entry else None
        ok = st.status == "ok"
        if st.status != "stopped":
            await model_test.record(
                s,
                provider,
                model_id,
                ok,
                st.ttft_ms if ok else None,
                st.error,
                task_type=dec.intent,
                commit=False,
            )
        chip.update(
            {
                "model": st.served or st.chosen.litellm_model,
                "provider": provider,
                "provider_name": p.name if p else provider,
                "tokens_in": tin,
                "tokens_out": tout,
                "estimated": estimated,
                "cost_usd": cost,
                "list_price_usd": list_price,
                "free_tier": free,
                "latency_ms": latency,
                "ttft_ms": st.ttft_ms,
            }
        )
    req.status = {"ok": "ok", "stopped": "stopped", "error": "error", "failed": "failed"}[st.status]
    req.latency_ms, req.ttft_ms = latency, st.ttft_ms
    req.error = secrets.redact(st.error) if st.error else None
    req.fallbacks_tried_json = [k.as_dict() for k in dec.skipped]
    req.decision_json = {
        **dec.as_dict(),
        "chosen": chip.get("target"),
        "reasons": chip["reasons"],
        "chip": chip,
    }
    asst.content = text
    asst.status = {"ok": "done", "stopped": "stopped", "error": "error", "failed": "error"}[st.status]
    if st.status in ("failed", "error"):
        chip["error"] = st.error
    asst.meta_json = chip
    thread.updated_at = datetime.now(UTC)
    await s.commit()
    return chip


async def local_title(client: httpx.AsyncClient, ctx: Context, user_text: str, answer: str) -> str | None:
    """A short title from the local model (never leaves the machine); None -> keep the words title."""
    if "ollama" not in ctx.connected:
        return None
    prompt = (
        "Write a title of 3 to 6 words for this conversation. Reply with the title only, no quotes.\n\n"
        f"User: {user_text[:600]}\nAssistant: {answer[:400]}"
    )
    body = {
        "model": TITLE_TARGET,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 24,
        "temperature": 0.2,
        "disable_fallbacks": True,
    }
    try:
        r = await client.post("/v1/chat/completions", json=body, timeout=TITLE_TIMEOUT_S)
        if r.status_code >= 400:
            return None
        return clean_title(r.json()["choices"][0]["message"].get("content") or "")
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None
