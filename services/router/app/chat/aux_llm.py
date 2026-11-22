"""Short internal generations (M3a): thread titles and long-thread summaries.

The local-model profile's `tasks` model answers through Ollama's native API with thinking off (qwen3
otherwise reasons inside its answer). When the profile has no tasks model (`none`, CPU only) or
Ollama fails, a free cloud model (`fast`) may answer instead, but only when `cloud_ok`: never for a
private thread.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

import httpx

from app import db, litellm_calls, local_profile, local_queue, ollama
from app.config import get_settings

log = logging.getLogger("app.chat.aux")

CLOUD_ALIAS = "fast"


async def generate(
    litellm: httpx.AsyncClient,
    prompt: str,
    *,
    max_tokens: int,
    timeout: float,
    cloud_ok: bool,
    connected: set[str],
    temperature: float = 0.2,
    private: bool = False,
    num_ctx: int | None = None,  # summaries need a longer window than Ollama's default; titles don't
    purpose: str | None = None,  # M2.5: "title" | "summary" -> a row in the Activity log
    thread_id: uuid.UUID | None = None,
) -> tuple[str | None, str | None]:
    """(text, model that wrote it) or (None, None)."""
    t0 = time.perf_counter()
    text, model, call_id = await _generate(
        litellm,
        prompt,
        max_tokens=max_tokens,
        timeout=timeout,
        cloud_ok=cloud_ok,
        connected=connected,
        temperature=temperature,
        private=private,
        num_ctx=num_ctx,
    )
    if purpose:
        await record(
            purpose,
            thread_id,
            private,
            model,
            call_id,
            ok=bool(text),
            ms=int((time.perf_counter() - t0) * 1000),
        )
    return text, model


async def record(
    purpose: str,
    thread_id: uuid.UUID | None,
    private: bool,
    model: str | None,
    call_id: str | None,
    *,
    ok: bool,
    ms: int,
) -> None:
    """One `requests` row per title or summary (kind `aux`), for the Activity log. Metrics keeps counting
    calls from their cost rows (the rollup skips `aux` requests). Best effort: never breaks a chat."""
    from app.models import Request

    tag = get_settings().router_request_tag
    try:
        async with db.sessionmaker()() as s:
            s.add(
                Request(
                    kind="aux",
                    status="ok" if ok else "error",
                    private=private,
                    thread_id=thread_id,
                    model=model,
                    latency_ms=ms,
                    call_id=call_id,
                    decision_json={"purpose": purpose, **({"tag": tag} if tag else {})},
                )
            )
            await s.commit()
    except Exception as e:  # noqa: BLE001 - logging must never fail the turn
        log.info("could not record the %s call (%s)", purpose, type(e).__name__)


async def _generate(
    litellm: httpx.AsyncClient,
    prompt: str,
    *,
    max_tokens: int,
    timeout: float,
    cloud_ok: bool,
    connected: set[str],
    temperature: float,
    private: bool,
    num_ctx: int | None,
) -> tuple[str | None, str | None, str | None]:
    prof = local_profile.active()
    if prof.tasks and "ollama" in connected:
        try:
            # One at a time, and never while a classification is in flight (local_queue). The wait
            # counts against `timeout`, so a busy queue ends in the usual fallback, not a hang.
            async with asyncio.timeout(timeout), local_queue.background():
                text = await ollama.chat(
                    prof.tasks,
                    [{"role": "user", "content": prompt}],
                    timeout=timeout,
                    keep_alive=prof.tasks_keep_alive,
                    think=False,
                    options={
                        "temperature": temperature,
                        "num_predict": max_tokens,
                        **prof.tasks_options,
                        **({"num_ctx": num_ctx} if num_ctx else {}),
                    },
                )
            if prof.tasks_on_gpu:  # a GPU tasks model can evict the others (small GPUs); CPU ones can't
                schedule_unload(prof.tasks)
                if not private:  # private threads skip the classifier: don't swap qwen out again
                    from app.routing import classifier

                    classifier.ensure_resident()
            if text:
                return text, f"ollama/{prof.tasks}", None
        except (ollama.OllamaError, local_queue.QueueFull, TimeoutError) as e:
            log.info("local %s failed (%s)%s", prof.tasks, e, "; trying the cloud" if cloud_ok else "")
    if not cloud_ok:
        return None, None, None
    call_id = litellm_calls.new_id("aux")
    body = {
        "model": CLOUD_ALIAS,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens * 4,  # reasoning models spend some tokens before answering
        "temperature": temperature,
        "disable_fallbacks": True,
    }
    litellm_calls.tag_body(body)
    try:
        # An sb-aux id: Metrics counts this call once, as a router task (title or summary), M6.
        r = await litellm.post(
            "/v1/chat/completions",
            json=body,
            timeout=timeout,
            headers=litellm_calls.headers(call_id),
        )
        if r.status_code >= 400:
            return None, CLOUD_ALIAS, call_id
        text = ollama.THINK.sub("", r.json()["choices"][0]["message"].get("content") or "").strip()
        return (text or None), (r.headers.get("x-litellm-model-name") or CLOUD_ALIAS), call_id
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None, CLOUD_ALIAS, call_id


_pending: set[asyncio.Task] = set()


def schedule_unload(used: str | None) -> None:
    """Keep at most `max_loaded` models in GPU memory, never evicting the classifier (background)."""
    prof = local_profile.active()
    keep = [m for m in (prof.classifier, used) if m]
    try:
        task = asyncio.get_running_loop().create_task(ollama.enforce_max_loaded(keep, prof.max_loaded))
    except RuntimeError:
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)
