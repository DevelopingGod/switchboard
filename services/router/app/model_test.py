"""1-token "pong" model tests and model_stats bookkeeping.

Aliases are tested through LiteLLM (what routing will use). A non-alias catalog model is called
directly at its provider with the stored key, so LiteLLM never needs client-side credentials.
"""

import statistics
import time
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import secrets
from app.models import ModelCatalog, ModelStats
from app.registry import Provider

PROMPT = "Reply with the single word: pong"
TIMEOUT = httpx.Timeout(60, connect=5)


class ModelTestError(RuntimeError):
    pass


async def call_provider(client: httpx.AsyncClient, p: Provider, model_id: str, key: str | None) -> None:
    if p.catalog == "gemini":
        url = f"{p.base_url}/models/{model_id}:generateContent"
        headers = {"x-goog-api-key": key or ""}
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": PROMPT}]}],
            "generationConfig": {"maxOutputTokens": 16},
        }
    elif p.catalog == "ollama":
        url, headers = f"{p.base_url}/api/chat", {}
        body = {
            "model": model_id,
            "stream": False,
            "messages": [{"role": "user", "content": PROMPT}],
            "options": {"num_predict": 16},
        }
    else:
        base = p.chat_base_url or p.base_url
        url, headers = f"{base}/chat/completions", {"Authorization": f"Bearer {key}"}
        body = {"model": model_id, "max_tokens": 16, "messages": [{"role": "user", "content": PROMPT}]}
    try:
        r = await client.post(url, headers=headers, json=body, timeout=TIMEOUT)
    except httpx.HTTPError as e:
        raise ModelTestError(f"{type(e).__name__} contacting {p.id}") from e
    if r.status_code >= 400:
        raise ModelTestError(secrets.redact(f"HTTP {r.status_code}: {r.text[:200]}"))


async def record(
    session: AsyncSession,
    provider: str,
    model_id: str,
    ok: bool,
    ms: int | None,
    error: str | None,
    task_type: str = "test",
    commit: bool = True,
) -> None:
    row = (
        await session.execute(
            select(ModelCatalog).where(ModelCatalog.provider == provider, ModelCatalog.model_id == model_id)
        )
    ).scalar_one_or_none()
    if row is None:
        return
    stats = (
        await session.execute(
            select(ModelStats).where(ModelStats.model_id == row.id, ModelStats.task_type == task_type)
        )
    ).scalar_one_or_none()
    if stats is None:
        stats = ModelStats(model_id=row.id, task_type=task_type, samples=0, failures=0, recent_ms=[])
        session.add(stats)
    stats.samples += 1
    stats.failures += 0 if ok else 1
    stats.error_rate = stats.failures / stats.samples
    stats.last_ok, stats.last_error = ok, error
    if ok and ms is not None:
        recent = [*stats.recent_ms, ms][-50:]
        stats.recent_ms = recent
        stats.p50_ms = int(statistics.median(recent))
        stats.p95_ms = int(sorted(recent)[max(0, round(0.95 * len(recent)) - 1)])
    if commit:
        await session.commit()


async def log_request(
    session: AsyncSession, model: str, ok: bool, ms: int, error: str | None, call_id: str | None
) -> None:
    """A model test in the Activity log (M2.5): a `requests` row of kind `test`. Metrics counts the call from
    its cost row as before (the rollup skips `test` requests)."""
    from app.config import get_settings
    from app.models import Request

    tag = get_settings().router_request_tag
    session.add(
        Request(
            kind="test",
            status="ok" if ok else "error",
            model=model[:255],
            latency_ms=ms,
            error=secrets.redact(error)[:500] if error else None,
            call_id=call_id,
            decision_json={"tag": tag} if tag else {},
        )
    )
    await session.commit()


def timer() -> float:
    return time.perf_counter()


def elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)
