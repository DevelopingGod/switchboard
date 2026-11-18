"""Self-healing LiteLLM sync (M1.5). Nobody should have to fix the gateway by hand.

One background task keeps LiteLLM's deployments equal to what Switchboard expects:
- a full reconcile on startup, then every `full_every_s` (5 min);
- a liveness probe every `alive_every_s` (10 s) and the expected-vs-actual diff (`reconcile.drift`)
  every `check_every_s` (30 s). LiteLLM coming back after being seen down (a restart), or any
  missing/stale deployment or credential, triggers a reconcile at once. LiteLLM v1.108.8 exposes no
  start time, so a restart shorter than one probe is caught by the diff (a restart that kept its DB
  needs no repair);
- a chat request that finds a deployment missing (LiteLLM "Invalid model name") requests a sync;
- `request()` from API handlers (a failed registration, the "Retry sync" button) wakes it now;
- failures retry with exponential backoff (2 s → 60 s) until one succeeds.

State is in memory (one router worker) and exposed by `snapshot()` for /system endpoints, provider
cards (`provider_errors`) and doctor.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import secrets
from app.litellm_admin import LiteLLMAdmin
from app.reconcile import drift, reconcile

log = logging.getLogger("app.sync")

BACKOFF_START_S = 2.0
BACKOFF_MAX_S = 60.0


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass
class SyncState:
    status: str = "pending"  # pending | ok | retrying
    last_ok_at: datetime | None = None
    last_attempt_at: datetime | None = None
    last_reason: str | None = None
    last_error: str | None = None
    next_retry_at: datetime | None = None
    attempts: int = 0
    last_changes: dict[str, int] = field(default_factory=dict)
    litellm_up: bool | None = None
    # provider id -> plain error, for providers whose registration failed (cleared by the next sync).
    provider_errors: dict[str, str] = field(default_factory=dict)

    def snapshot(self) -> dict[str, Any]:
        iso = lambda d: d.isoformat() if d else None  # noqa: E731
        return {
            "status": self.status,
            "last_ok_at": iso(self.last_ok_at),
            "last_attempt_at": iso(self.last_attempt_at),
            "last_reason": self.last_reason,
            "last_error": self.last_error,
            "next_retry_at": iso(self.next_retry_at),
            "attempts": self.attempts,
            "last_changes": self.last_changes,
            "litellm_up": self.litellm_up,
            "provider_errors": dict(self.provider_errors),
        }


state = SyncState()
_wake = asyncio.Event()
_pending_reason: str | None = None


def request(reason: str, provider: str | None = None, error: str | None = None) -> None:
    """Ask the background task to sync now. `provider`/`error` mark a failed registration."""
    global _pending_reason
    if provider and error:
        state.provider_errors[provider] = secrets.redact(error)[:200]
    _pending_reason = _pending_reason or reason
    _wake.set()


def reset() -> None:
    """Tests: fresh state (and a fresh Event: an Event binds to the first loop that waits on it)."""
    global state, _pending_reason, _wake
    state = SyncState()
    _pending_reason = None
    _wake = asyncio.Event()


async def sync_once(session: AsyncSession, admin: LiteLLMAdmin, reason: str) -> dict[str, list[str]]:
    """One reconcile, recording the outcome. Raises on failure (callers decide on retry)."""
    state.last_attempt_at = _now()
    state.last_reason = reason
    state.attempts += 1
    try:
        result = await reconcile(session, admin)
    except Exception as e:
        state.status = "retrying"
        state.last_error = secrets.redact(str(e))[:200]
        raise
    state.status, state.last_error, state.next_retry_at = "ok", None, None
    state.last_ok_at = _now()
    state.attempts = 0
    state.last_changes = {k: len(v) for k, v in result.items() if k != "kept"}
    state.provider_errors.clear()
    if result["added"] or result["removed"]:
        log.info("sync (%s): +%d -%d", reason, len(result["added"]), len(result["removed"]))
    return result


async def check_once(session: AsyncSession | None, admin: LiteLLMAdmin) -> str | None:
    """Cheap check. Returns why a sync is needed, or None when LiteLLM matches what we expect.
    Without a session only liveness is checked."""
    up = await admin.alive()
    was_up, state.litellm_up = state.litellm_up, up
    if not up:
        return None  # nothing to do until it is back; the restart is caught on the way up
    if was_up is False:
        return "LiteLLM came back (restart)"
    if session is None:
        return None
    d = await drift(session, admin)
    if d["missing"] or d["stale"] or d["missing_credentials"]:
        n = len(d["missing"]) + len(d["stale"]) + len(d["missing_credentials"])
        return f"LiteLLM differs from Switchboard ({n} deployment(s) or credential(s))"
    return None


async def run_forever(
    sessionmaker: async_sessionmaker[AsyncSession],
    admin: LiteLLMAdmin,
    full_every_s: float = 300,
    check_every_s: float = 30,
    alive_every_s: float = 10,
) -> None:
    global _pending_reason
    reason: str | None = "startup"
    delay = BACKOFF_START_S
    last_full = last_diff = 0.0
    loop = asyncio.get_running_loop()
    while True:
        try:
            if reason is None:
                if loop.time() - last_diff >= check_every_s:
                    last_diff = loop.time()
                    async with sessionmaker() as session:
                        reason = await check_once(session, admin)
                else:
                    reason = await check_once(None, admin)
                if reason is None and loop.time() - last_full >= full_every_s:
                    reason = "periodic"
            if reason is not None:
                async with sessionmaker() as session:
                    await sync_once(session, admin, reason)
                last_full, reason, delay = loop.time(), None, BACKOFF_START_S
                last_diff = last_full
            wait = min(alive_every_s, check_every_s)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("sync failed (%s); retrying in %.0fs", secrets.redact(str(e))[:200], delay)
            state.status = "retrying"
            state.last_error = secrets.redact(str(e))[:200]
            reason = reason or "retry"
            wait, delay = delay, min(delay * 2, BACKOFF_MAX_S)
            state.next_retry_at = _now() + timedelta(seconds=wait)
        if not _wake.is_set():  # a request() during the sync above must not be lost
            try:
                await asyncio.wait_for(_wake.wait(), timeout=wait)
            except TimeoutError:
                continue
        _wake.clear()
        reason = _pending_reason or "requested"
        _pending_reason = None
        delay = BACKOFF_START_S
