"""Direct calls to Ollama's native API (M3a): the classifier, titles and summaries, model pulls and
keeping at most `max_loaded` models in GPU memory.

Chat replies still go through LiteLLM (costs, logs); these short internal calls go straight to Ollama
so the router can set `keep_alive`, `think` and `format`, which the OpenAI-style path doesn't carry.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger("app.ollama")

THINK = re.compile(r"<think>.*?(</think>|$)", re.S)


def base() -> str:
    return get_settings().ollama_api_base.rstrip("/")


class OllamaError(RuntimeError):
    pass


async def chat(
    model: str,
    messages: list[dict[str, str]],
    *,
    timeout: float,
    keep_alive: str | int = "10m",
    fmt: str | None = None,
    think: bool | None = False,
    options: dict[str, Any] | None = None,
    client: httpx.AsyncClient | None = None,
) -> str:
    """One non-streamed reply; reasoning (`thinking`, `<think>` blocks) is dropped."""
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": keep_alive,
        "options": options or {},
    }
    if fmt:
        body["format"] = fmt
    if think is not None:
        body["think"] = think
    try:
        if client is None:
            async with httpx.AsyncClient() as c:
                r = await c.post(f"{base()}/api/chat", json=body, timeout=timeout)
        else:
            r = await client.post(f"{base()}/api/chat", json=body, timeout=timeout)
    except httpx.TimeoutException as e:
        raise OllamaError(f"no answer within {timeout:g} s") from e
    except httpx.HTTPError as e:
        raise OllamaError(f"Ollama unreachable ({type(e).__name__})") from e
    if r.status_code == 404:
        raise OllamaError(f"model {model} is not pulled")
    if r.status_code >= 400:
        raise OllamaError(f"Ollama HTTP {r.status_code}")
    try:
        content = (r.json().get("message") or {}).get("content") or ""
    except ValueError as e:
        raise OllamaError("Ollama returned non-JSON") from e
    return THINK.sub("", content).strip()


async def tags(timeout: float = 3) -> list[str] | None:
    """Pulled model names, or None when Ollama can't be reached."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(f"{base()}/api/tags")
        return [m["name"] for m in r.json().get("models", [])] if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError, KeyError):
        return None


async def ps(timeout: float = 3) -> list[dict[str, Any]] | None:
    """Loaded models with their memory use (`ollama ps`)."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(f"{base()}/api/ps")
        return list(r.json().get("models", [])) if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


async def unload(model: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(f"{base()}/api/generate", json={"model": model, "keep_alive": 0})
    except httpx.HTTPError:
        pass


async def enforce_max_loaded(keep: list[str], max_loaded: int) -> list[str]:
    """Unload models beyond `max_loaded`, never the ones in `keep` (classifier first). Ollama would
    otherwise evict by least-recent use, which is usually the resident classifier. Returns unloaded."""
    loaded = await ps()
    if not loaded or len(loaded) <= max_loaded:
        return []
    names = [m.get("name") or m.get("model") for m in loaded]
    extra = [n for n in names if n and n not in keep]
    to_unload = extra[: len(names) - max_loaded]
    for n in to_unload:
        await unload(n)
    if to_unload:
        log.info("unloaded %s to keep %d model(s) in memory", ", ".join(to_unload), max_loaded)
    return to_unload


# --- pulls (Settings → Local models, Status "Pull models") ------------------------------------------
pull_state: dict[str, Any] = {"status": "idle", "model": None, "done": [], "error": None, "percent": None}
_pull_lock = asyncio.Lock()


async def pull(models: list[str]) -> None:
    """Pull each model in turn (background task). Progress lands in `pull_state`."""
    if _pull_lock.locked():
        return
    async with _pull_lock:
        pull_state.update(status="running", done=[], error=None, percent=None)
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=600)) as c:
                for m in models:
                    pull_state.update(model=m, percent=0)
                    async with c.stream("POST", f"{base()}/api/pull", json={"model": m}) as r:
                        if r.status_code >= 400:
                            raise OllamaError(f"pull {m}: HTTP {r.status_code}")
                        async for line in r.aiter_lines():
                            if '"error"' in line:
                                raise OllamaError(f"pull {m}: {line[:160]}")
                            total = re.search(r'"total":(\d+)', line)
                            done = re.search(r'"completed":(\d+)', line)
                            if total and done and int(total.group(1)):
                                pull_state["percent"] = round(100 * int(done.group(1)) / int(total.group(1)))
                    pull_state["done"].append(m)
            pull_state.update(status="done", model=None, percent=100)
        except (httpx.HTTPError, OllamaError) as e:
            pull_state.update(status="error", error=str(e)[:200])
            log.warning("model pull failed: %s", e)
