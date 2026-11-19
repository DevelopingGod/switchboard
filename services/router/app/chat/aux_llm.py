"""Short internal generations (M3a): thread titles and long-thread summaries.

The local-model profile's `tasks` model answers through Ollama's native API with thinking off (qwen3
otherwise reasons inside its answer). When the profile has no tasks model (`none`, CPU only) or
Ollama fails, a free cloud model (`fast`) may answer instead, but only when `cloud_ok`: never for a
private thread.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app import local_profile, ollama

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
) -> tuple[str | None, str | None]:
    """(text, model that wrote it) or (None, None)."""
    prof = local_profile.active()
    if prof.tasks and "ollama" in connected:
        try:
            text = await ollama.chat(
                prof.tasks,
                [{"role": "user", "content": prompt}],
                timeout=timeout,
                keep_alive="10m",
                think=False,
                options={
                    "temperature": temperature,
                    "num_predict": max_tokens,
                    **({"num_ctx": num_ctx} if num_ctx else {}),
                },
            )
            schedule_unload(prof.tasks)
            if not private:  # private threads skip the classifier: don't swap qwen out again
                from app.routing import classifier

                classifier.ensure_resident()
            if text:
                return text, f"ollama/{prof.tasks}"
        except ollama.OllamaError as e:
            log.info("local %s failed (%s)%s", prof.tasks, e, "; trying the cloud" if cloud_ok else "")
    if not cloud_ok:
        return None, None
    body = {
        "model": CLOUD_ALIAS,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens * 4,  # reasoning models spend some tokens before answering
        "temperature": temperature,
        "disable_fallbacks": True,
    }
    try:
        r = await litellm.post("/v1/chat/completions", json=body, timeout=timeout)
        if r.status_code >= 400:
            return None, None
        text = ollama.THINK.sub("", r.json()["choices"][0]["message"].get("content") or "").strip()
        return (text or None), (r.headers.get("x-litellm-model-name") or CLOUD_ALIAS) if text else None
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None, None


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
