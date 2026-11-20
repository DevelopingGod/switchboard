"""Thin adapter over Paperclip's REST API (pinned 2026.1106.0; ADR 0007, docs/m4a.md).

Only the calls jobs need, each verified against the installed version (recorded request/response pairs are
the contract fixtures in tests/fixtures/paperclip/):

- company: list / create (one "Switchboard" company)
- agents: create, read, set config, set the task (`AGENTS.md` in the instructions bundle), environment test,
  lifecycle retry
- runs: agent-level wake (no issue scope, so Paperclip never re-wakes anyone), status, log by byte offset,
  cancel
- issues (the job record), comments, approvals

Self-healing (M1.5): transient failures (connection errors, 5xx) are retried with backoff on calls that are
safe to repeat (reads, and writes that carry an idempotency key or are idempotent on Paperclip's side:
cancel, approve, reject, config writes). "Not found" on cancel is success. Errors are plain sentences, never
request bodies.

Never send back what a read returned: Paperclip redacts some env values on read and refuses the placeholder
on write (422 "Refusing to persist redacted placeholder"), so callers always send a complete config of their
own.
"""

from __future__ import annotations

import asyncio
import json as jsonlib
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger("app.paperclip")

PINNED_VERSION = "2026.1106.0"
RETRY_DELAYS_S = (0.5, 1.5)
TERMINAL_RUN = frozenset({"succeeded", "failed", "cancelled", "timed_out"})


class PaperclipError(RuntimeError):
    """A plain-language failure; `status` is the HTTP status (0 = unreachable)."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class LogPage:
    lines: list[dict[str, Any]]  # parsed NDJSON lines: {ts, stream, chunk}
    next_offset: int  # byte offset after the last complete line


def loopback_host_header(url: str) -> str | None:
    """Paperclip only answers requests whose Host is a loopback name (its DNS-rebinding guard: 403 "This
    hostname is not allowed" for `host.docker.internal`, verified). The router reaches it from Docker through
    `host.docker.internal`, so it presents the loopback name Paperclip expects, as a reverse proxy would,
    instead of widening Paperclip's allowed hostnames."""
    u = httpx.URL(url)
    if u.host == "host.docker.internal":
        return f"127.0.0.1:{u.port or 80}"
    return None


def _short(r: httpx.Response) -> str:
    try:
        body = r.json()
        msg = body.get("error") or body.get("message") if isinstance(body, dict) else None
    except ValueError:
        msg = None
    return str(msg or r.text or r.reason_phrase)[:200]


class Paperclip:
    def __init__(self, client: httpx.AsyncClient | None = None):
        s = get_settings()
        headers = {"Content-Type": "application/json"}
        host = loopback_host_header(s.paperclip_url)
        if host:
            headers["Host"] = host
        key = s.paperclip_api_key.get_secret_value().strip() if s.paperclip_api_key else ""
        if key:  # authenticated deployments only (ADR 0007); compose passes an empty value otherwise
            headers["Authorization"] = f"Bearer {key}"
        self._client = client or httpx.AsyncClient(
            base_url=s.paperclip_url.rstrip("/") + "/api", headers=headers, timeout=30
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _req(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        retry: bool = False,
        missing_ok: bool = False,
        timeout: float | None = None,
    ) -> Any:
        attempts = (0.0, *RETRY_DELAYS_S) if retry else (0.0,)
        last: PaperclipError | None = None
        for delay in attempts:
            if delay:
                await asyncio.sleep(delay)
            try:
                kw: dict[str, Any] = {"json": json, "params": params}
                if timeout is not None:
                    kw["timeout"] = timeout
                r = await self._client.request(method, path, **kw)
            except httpx.HTTPError as e:
                last = PaperclipError(f"Paperclip is not reachable ({type(e).__name__})", 0)
                continue
            if r.status_code == 404 and missing_ok:
                return None
            if r.status_code >= 500:
                last = PaperclipError(f"Paperclip error {r.status_code}: {_short(r)}", r.status_code)
                continue
            if r.status_code >= 400:
                raise PaperclipError(f"Paperclip refused {method} {path}: {_short(r)}", r.status_code)
            return r.json() if r.content else None
        assert last is not None
        raise last

    # --- health ---------------------------------------------------------------------------------------
    async def health(self) -> dict[str, Any] | None:
        """`/api/health`, or None when Paperclip can't be reached. Never raises."""
        try:
            r = await self._client.get("/health", timeout=3)
        except httpx.HTTPError:
            return None
        if r.status_code != 200:
            return None
        try:
            return r.json()
        except ValueError:
            return None

    # --- company --------------------------------------------------------------------------------------
    async def companies(self) -> list[dict[str, Any]]:
        return await self._req("GET", "/companies", retry=True) or []

    async def create_company(self, name: str, description: str) -> dict[str, Any]:
        return await self._req("POST", "/companies", json={"name": name, "description": description})

    # --- agents ---------------------------------------------------------------------------------------
    async def agents(self, company_id: str) -> list[dict[str, Any]]:
        return await self._req("GET", f"/companies/{company_id}/agents", retry=True) or []

    async def agent(self, agent_id: str) -> dict[str, Any] | None:
        return await self._req("GET", f"/agents/{agent_id}", retry=True, missing_ok=True)

    async def create_agent(
        self,
        company_id: str,
        *,
        name: str,
        adapter_type: str,
        adapter_config: dict[str, Any],
        instructions: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        # Timer heartbeats off: a Switchboard agent only ever runs when a job wakes it.
        return await self._req(
            "POST",
            f"/companies/{company_id}/agents",
            json={
                "name": name,
                "adapterType": adapter_type,
                "adapterConfig": adapter_config,
                "instructionsBundle": {"entryFile": "AGENTS.md", "files": {"AGENTS.md": instructions}},
                "runtimeConfig": {"heartbeat": {"enabled": False}},
                "metadata": metadata,
            },
        )

    async def set_agent_config(self, agent_id: str, adapter_config: dict[str, Any]) -> dict[str, Any]:
        """Replace the adapter config (always a complete config of our own; see the module docstring)."""
        return await self._req(
            "PATCH", f"/agents/{agent_id}", json={"adapterConfig": adapter_config}, retry=True
        )

    async def set_instructions(self, agent_id: str, content: str) -> None:
        """The task for the next run (Claude reads `AGENTS.md` as its system prompt addition)."""
        await self._req(
            "PUT",
            f"/agents/{agent_id}/instructions-bundle/file",
            json={"path": "AGENTS.md", "content": content},
            retry=True,
        )

    async def test_environment(
        self, company_id: str, adapter_type: str, adapter_config: dict[str, Any]
    ) -> dict[str, Any]:
        """Paperclip's own adapter check: {status: pass|warn|fail, checks: [{level, code, message, hint}]}."""
        return await self._req(
            "POST",
            f"/companies/{company_id}/adapters/{adapter_type}/test-environment",
            json={"adapterConfig": adapter_config},
            timeout=180,
        )

    async def retry_lifecycle(self, agent_id: str) -> None:
        await self._req("POST", f"/agents/{agent_id}/lifecycle/retry", json={}, retry=True)

    # --- runs -----------------------------------------------------------------------------------------
    async def wake(self, agent_id: str, *, reason: str, idempotency_key: str) -> dict[str, Any]:
        """Start one agent-level run (no issue scope). Returns the run, or {status: "skipped"} when the same
        idempotency key already started one (a retried request)."""
        return await self._req(
            "POST",
            f"/agents/{agent_id}/wakeup",
            json={
                "source": "on_demand",
                "triggerDetail": "manual",
                "reason": reason,
                "forceFreshSession": True,
                "idempotencyKey": idempotency_key,
            },
            retry=True,
        )

    async def run(self, run_id: str) -> dict[str, Any] | None:
        return await self._req("GET", f"/heartbeat-runs/{run_id}", retry=True, missing_ok=True)

    async def runs(self, company_id: str) -> list[dict[str, Any]]:
        return await self._req("GET", f"/companies/{company_id}/heartbeat-runs", retry=True) or []

    async def run_log(self, run_id: str, offset: int = 0, limit_bytes: int = 65536) -> LogPage:
        """One page of the run's output. Only complete NDJSON lines are returned; `next_offset` points just
        after the last one, so a line cut by the page limit is read whole next time."""
        data = await self._req(
            "GET",
            f"/heartbeat-runs/{run_id}/log",
            params={"offset": offset, "limitBytes": limit_bytes},
            retry=True,
            missing_ok=True,
        )
        content = (data or {}).get("content") or ""
        raw = content.encode()
        cut = raw.rfind(b"\n")
        if cut < 0:
            # One line longer than the page: let the caller ask for more next time (the line is still growing,
            # or the page was too small). Never loop on it: advance only when Paperclip says the run moved on.
            return LogPage([], offset)
        lines: list[dict[str, Any]] = []
        for line in raw[: cut + 1].splitlines():
            try:
                obj = jsonlib.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                lines.append(obj)
        return LogPage(lines, offset + cut + 1)

    async def cancel_run(self, run_id: str) -> None:
        """Stop a run. Already finished or unknown = done."""
        await self._req("POST", f"/heartbeat-runs/{run_id}/cancel", json={}, retry=True, missing_ok=True)

    # --- the job's record -----------------------------------------------------------------------------
    async def create_issue(
        self,
        company_id: str,
        *,
        title: str,
        description: str,
        assignee_user_id: str | None,
        idempotency_key: str,
    ) -> dict[str, Any]:
        """The job's Paperclip issue, owned by the board user and never by an agent (ADR 0007). The same
        idempotency key returns the same issue."""
        body: dict[str, Any] = {
            "title": title[:240],
            "description": description,
            "status": "todo",
            "idempotencyKey": idempotency_key,
        }
        if assignee_user_id:
            body["assigneeUserId"] = assignee_user_id
        return await self._req("POST", f"/companies/{company_id}/issues", json=body, retry=True)

    async def update_issue(self, issue_id: str, **fields: Any) -> None:
        """e.g. status="in_progress", assigneeUserId=<the board user> (in_progress needs an owner)."""
        await self._req("PATCH", f"/issues/{issue_id}", json=fields, retry=True)

    async def set_issue_status(self, issue_id: str, status: str) -> None:
        await self.update_issue(issue_id, status=status)

    async def comment(self, issue_id: str, body: str) -> None:
        await self._req("POST", f"/issues/{issue_id}/comments", json={"body": body[:60_000]})

    async def create_approval(
        self, company_id: str, *, issue_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        return await self._req(
            "POST",
            f"/companies/{company_id}/approvals",
            json={"type": "request_board_approval", "payload": payload, "issueIds": [issue_id]},
        )

    async def approval(self, approval_id: str) -> dict[str, Any] | None:
        return await self._req("GET", f"/approvals/{approval_id}", retry=True, missing_ok=True)

    async def decide(self, approval_id: str, approve: bool, note: str | None) -> dict[str, Any]:
        """Approve or reject. Deciding the same way twice is accepted by Paperclip (idempotent)."""
        action = "approve" if approve else "reject"
        return await self._req(
            "POST", f"/approvals/{approval_id}/{action}", json={"decisionNote": note or None}, retry=True
        )
