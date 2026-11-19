"""Streams one routed request through LiteLLM, walking the decision's candidates (SPEC §7.1 step 5-6).

The router owns cross-target fallback (every request sends `disable_fallbacks: true`) so each skip
can be explained. A candidate that fails *before* its first answer token (429, 5xx, timeout,
connection error) is skipped with a reason and the next one is tried; after the first token, a
failure ends the reply (no duplicated output). Reasoning text (`reasoning_content`, `<think>`) is
streamed as "thinking" and never becomes part of the answer.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from app import secrets
from app.config import get_settings
from app.routing.engine import Candidate, Decision, Skip
from app.routing.health import CREDIT_S, ERROR_S, NOT_FOUND_S, RATE_LIMIT_S, TIMEOUT_S, Cooldowns

INJECTED_TIMEOUT_S = 0.05


# --- events -------------------------------------------------------------------------------------
@dataclass
class Route:
    candidate: Candidate


@dataclass
class Fallback:
    skip: Skip
    next: Candidate | None


@dataclass
class Thinking:
    text: str


@dataclass
class Delta:
    text: str


@dataclass
class Usage:
    usage: dict[str, Any]


@dataclass
class Served:
    model: str  # deployment that answered, e.g. groq/openai/gpt-oss-120b


@dataclass
class RateHeaders:
    """Provider rate-limit headers (x-ratelimit-*), on success or a 429 (M3a quota guard)."""

    candidate: Candidate
    headers: dict[str, str]


@dataclass
class Failed:
    candidate: Candidate
    reason: str  # after the first token: the reply ends here
    kind: str = "error"  # UpstreamError code, mapped to plain language by the portal


@dataclass
class Exhausted:
    pass


class Stopped(Exception):
    pass


class UpstreamError(Exception):
    def __init__(self, code: str, reason: str, cooldown_s: float = 0):
        super().__init__(reason)
        self.code, self.reason, self.cooldown_s = code, reason, cooldown_s
        self.headers: dict[str, str] = {}


@dataclass(frozen=True)
class Fault:
    """Dev-only fault injection (ROUTER_FAULT_INJECTION=1): fail `target` with a 429 or a timeout."""

    target: str
    kind: str  # "429" | "timeout"


# --- <think> splitting --------------------------------------------------------------------------
class ThinkSplitter:
    """Splits `<think>…</think>` spans out of content deltas, even when tags straddle chunks."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self.inside = False
        self.buf = ""

    def feed(self, text: str) -> list[tuple[str, str]]:
        self.buf += text
        out: list[tuple[str, str]] = []
        while self.buf:
            tag = self.CLOSE if self.inside else self.OPEN
            i = self.buf.find(tag)
            if i >= 0:
                if i:
                    out.append(("thinking" if self.inside else "content", self.buf[:i]))
                self.buf = self.buf[i + len(tag) :]
                self.inside = not self.inside
                continue
            # keep a possible partial tag at the end for the next chunk
            keep = next((k for k in range(len(tag) - 1, 0, -1) if self.buf.endswith(tag[:k])), 0)
            emit, self.buf = (self.buf[:-keep], self.buf[-keep:]) if keep else (self.buf, "")
            if emit:
                out.append(("thinking" if self.inside else "content", emit))
            break
        return out

    def flush(self) -> list[tuple[str, str]]:
        rest, self.buf = self.buf, ""
        return [("thinking" if self.inside else "content", rest)] if rest else []


# --- upstream -----------------------------------------------------------------------------------
# A provider out of credit answers 402, or (through LiteLLM) another status with one of these phrases.
CREDIT_LIMIT = re.compile(
    r"\b402\b|payment required|insufficient[ _](credits?|funds|balance)|credit limit|more credits"
    r"|can only afford|out of credits?|exceeded your (current )?quota.*billing",
    re.I,
)
CREDIT_REASON = "Credit limit reached (402): add credits, or use a :free model"


def is_credit_limit(status: int, text: str) -> bool:
    return status == 402 or bool(CREDIT_LIMIT.search(text))


def classify(status: int, body: str, retry_after: str | None) -> UpstreamError:
    text = secrets.redact(body)[:160]
    if status != 429 and is_credit_limit(status, body):
        return UpstreamError("credit_limit", CREDIT_REASON, CREDIT_S)
    if status == 429:
        wait = RATE_LIMIT_S
        if retry_after and retry_after.isdigit():
            wait = max(5, min(int(retry_after), 600))
        return UpstreamError("rate_limited", "Rate limited (429)", wait)
    if status in (401, 403):
        return UpstreamError("error", f"Key rejected ({status})", ERROR_S)
    if status == 400 and "Invalid model name" in body:
        # LiteLLM lacks a deployment we expect (restart, manual delete): resync now, not in 30 s.
        from app import sync

        sync.request("chat found a deployment missing in LiteLLM")
        return UpstreamError("not_connected", "Not registered in LiteLLM yet (reconcile pending)", ERROR_S)
    if status == 404:
        # Usually a retired model (OpenRouter's free lineup rotates): skip it until the catalog
        # refresh that the router starts right away marks it missing.
        return UpstreamError(
            "not_found", "Model not found at the provider (404); skipped for 6 h", NOT_FOUND_S
        )
    if status in (408, 504):
        return UpstreamError("timeout", f"Provider timed out ({status})", TIMEOUT_S)
    if status >= 500:
        return UpstreamError("error", f"Provider error ({status})", ERROR_S)
    return UpstreamError("error", f"Request rejected ({status}): {text}", 0)


async def _stream_one(
    client: httpx.AsyncClient,
    cand: Candidate,
    dec: Decision,
    messages: list[dict[str, str]],
    cancel: asyncio.Event,
    fault: Fault | None,
) -> AsyncIterator[object]:
    read_timeout = cand.timeout
    if fault and fault.target == cand.target:
        if fault.kind == "429":
            raise UpstreamError("rate_limited", "Rate limited (429, injected for testing)", RATE_LIMIT_S)
        read_timeout = INJECTED_TIMEOUT_S
    body = {
        "model": cand.litellm_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "disable_fallbacks": True,
        "temperature": dec.temperature,
        "max_tokens": cand.max_tokens,
    }
    tag = get_settings().router_request_tag
    if tag:  # demo recordings: LiteLLM spend logs carry it so Metrics can exclude them
        body["user"] = tag
        body["metadata"] = {"tags": [tag]}
    timeout = httpx.Timeout(connect=5, read=read_timeout, write=10, pool=5)
    splitter = ThinkSplitter()
    try:
        async with client.stream("POST", "/v1/chat/completions", json=body, timeout=timeout) as r:
            rate = {k: v for k, v in r.headers.items() if "ratelimit" in k.lower()}
            if r.status_code >= 400:
                raw = (await r.aread()).decode(errors="replace")
                err = classify(r.status_code, raw, r.headers.get("retry-after"))
                err.headers = rate
                raise err
            if rate:
                yield RateHeaders(cand, rate)
            served = r.headers.get("x-litellm-model-name")
            if served:
                yield Served(served)
            async for line in r.aiter_lines():
                if cancel.is_set():
                    raise Stopped()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                if obj.get("error"):
                    err = obj["error"]
                    msg = err.get("message", "stream error") if isinstance(err, dict) else str(err)
                    if is_credit_limit(0, msg):
                        raise UpstreamError("credit_limit", CREDIT_REASON, CREDIT_S)
                    code = "rate_limited" if "429" in msg or "RateLimit" in msg else "error"
                    raise UpstreamError(
                        code, secrets.redact(msg)[:120], RATE_LIMIT_S if code == "rate_limited" else ERROR_S
                    )
                if obj.get("usage"):
                    yield Usage(obj["usage"])
                for ch in obj.get("choices") or []:
                    delta = ch.get("delta") or {}
                    if delta.get("reasoning_content"):
                        yield Thinking(delta["reasoning_content"])
                    if delta.get("content"):
                        for kind, text in splitter.feed(delta["content"]):
                            yield Thinking(text) if kind == "thinking" else Delta(text)
            for kind, text in splitter.flush():
                yield Thinking(text) if kind == "thinking" else Delta(text)
    except httpx.TimeoutException as e:
        raise UpstreamError("timeout", f"No answer within {read_timeout:g} s", TIMEOUT_S) from e
    except httpx.HTTPError as e:
        raise UpstreamError("error", f"Could not reach LiteLLM ({type(e).__name__})", ERROR_S) from e


async def dispatch(
    client: httpx.AsyncClient,
    dec: Decision,
    messages: list[dict[str, str]],
    cancel: asyncio.Event,
    cooldowns: Cooldowns,
    fault: Fault | None = None,
) -> AsyncIterator[object]:
    """Yields Route, Fallback, Thinking, Delta, Served, Usage, RateHeaders, then ends; or Failed /
    Exhausted."""
    for i, cand in enumerate(dec.candidates):
        yield Route(cand)
        committed = False
        try:
            async for ev in _stream_one(client, cand, dec, messages, cancel, fault):
                if isinstance(ev, Delta):
                    committed = True
                yield ev
            return
        except UpstreamError as e:
            if e.cooldown_s:
                cooldowns.set(cand.target, e.code, e.reason, e.cooldown_s, provider=cand.provider)
            if e.headers:
                yield RateHeaders(cand, e.headers)
            if committed:
                yield Failed(cand, e.reason, e.code)
                return
            skip = Skip(cand.target, cand.label, e.code, e.reason)
            dec.skipped.append(skip)
            yield Fallback(skip, dec.candidates[i + 1] if i + 1 < len(dec.candidates) else None)
    yield Exhausted()
