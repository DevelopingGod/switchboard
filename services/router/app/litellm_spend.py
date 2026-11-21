"""Thin adapter over LiteLLM's spend logs (M6). Verified on v1.108.8 (docs/m6.md, tests/fixtures/
litellm_spend_logs_v2.json):

GET /spend/logs/v2?start_date=YYYY-MM-DD HH:MM:SS&end_date=…&page=N&page_size≤100&sort_by=startTime&
sort_order=asc → {"data": [...], "total", "page", "page_size", "total_pages"}. Times are UTC. Each row has
`litellm_call_id` (the caller's `x-litellm-call-id` when one was sent), `status` (success | failure), `spend`
(LiteLLM's list-price cost), `prompt_tokens`, `completion_tokens`, `model` (deployment, e.g.
`groq/openai/gpt-oss-120b`), `custom_llm_provider`, `model_group` (the alias asked for), `end_user` (the
body's `user`), `request_tags` and `startTime`. Only these fields are read: an upstream change shows up as a
contract-test failure, not as wrong numbers.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from app.config import get_settings

PAGE_SIZE = 100
FMT = "%Y-%m-%d %H:%M:%S"


class SpendLogError(RuntimeError):
    pass


@dataclass(frozen=True)
class SpendLog:
    call_id: str
    status: str
    spend: float | None
    tokens_in: int
    tokens_out: int
    model: str
    provider: str
    model_group: str
    end_user: str
    tags: tuple[str, ...]
    started: datetime

    @classmethod
    def parse(cls, r: dict[str, Any]) -> SpendLog | None:
        cid = (
            r.get("litellm_call_id")
            or (r.get("metadata") or {}).get("litellm_call_id")
            or r.get("request_id")
        )
        st = r.get("startTime")
        if not cid or not st:
            return None
        try:
            started = datetime.fromisoformat(str(st).replace("Z", "+00:00"))
        except ValueError:
            return None
        if started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
        spend = r.get("spend")
        return cls(
            call_id=str(cid)[:100],
            status=str(r.get("status") or "success"),
            spend=float(spend) if spend is not None else None,
            tokens_in=int(r.get("prompt_tokens") or 0),
            tokens_out=int(r.get("completion_tokens") or 0),
            model=str(r.get("model") or ""),
            provider=str(r.get("custom_llm_provider") or ""),
            model_group=str(r.get("model_group") or ""),
            end_user=str(r.get("end_user") or ""),
            tags=tuple(str(t) for t in (r.get("request_tags") or []) if isinstance(t, str)),
            started=started,
        )


class LiteLLMSpend:
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        s = get_settings()
        self._own = client is None
        self._client = client or httpx.AsyncClient(
            base_url=s.litellm_url,
            headers={"Authorization": f"Bearer {s.litellm_master_key.get_secret_value()}"},
            timeout=httpx.Timeout(30, connect=5),
        )

    async def aclose(self) -> None:
        if self._own:
            await self._client.aclose()

    async def page(self, start: datetime, end: datetime, page: int) -> tuple[list[dict[str, Any]], int]:
        params = {
            "start_date": start.astimezone(UTC).strftime(FMT),
            "end_date": end.astimezone(UTC).strftime(FMT),
            "page": page,
            "page_size": PAGE_SIZE,
            "sort_by": "startTime",
            "sort_order": "asc",
        }
        try:
            r = await self._client.get("/spend/logs/v2", params=params)
        except httpx.HTTPError as e:
            raise SpendLogError(f"LiteLLM spend logs unreachable ({type(e).__name__})") from e
        if r.status_code >= 400:
            raise SpendLogError(f"LiteLLM GET /spend/logs/v2 -> {r.status_code}")
        try:
            body = r.json()
            return list(body.get("data") or []), int(body.get("total_pages") or 1)
        except (ValueError, TypeError, AttributeError) as e:
            raise SpendLogError("LiteLLM spend logs: unexpected response shape") from e

    async def logs(self, start: datetime, end: datetime, max_pages: int = 50) -> AsyncIterator[SpendLog]:
        """Every log in [start, end], oldest first (at most `max_pages` pages per call)."""
        n, pages = 1, 1
        while n <= pages and n <= max_pages:
            rows, pages = await self.page(start, end, n)
            for row in rows:
                if (log := SpendLog.parse(row)) is not None:
                    yield log
            if not rows:
                break
            n += 1
