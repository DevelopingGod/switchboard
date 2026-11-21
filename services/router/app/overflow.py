"""Paid overflow (M6.5, ADR 0015): opt-in, off by default, only after you confirm "Paid — up to $X".

When every subscription window in a job's chain is used up, the job can run on a paid model instead, through
the `opencode-paid` agent (OpenCode → LiteLLM). Each run gets its own LiteLLM virtual key:

- budget-capped (`max_budget` = what is left of the job's paid budget and of this month's overflow budget),
  model-limited (only the model you chose), short-lived (the job's time limit plus a margin);
- written by hostprobe to `~/.switchboard/overflow/<agent>.key` (mode 600) right before the run, and read by
  OpenCode with `{file:...}`: the key never enters Paperclip, whose agent config keeps every revision;
- revoked and its file removed when the run ends, whatever the outcome; a sweep on start and every few
  minutes removes anything left by a crash.

The running agent can read its own key (true of any way of giving it one), which is why the key is per run,
capped, limited to one model and short-lived. LiteLLM's spend log is the truth for what it cost: the run's key
carries the tags `switchboard-overflow` and `sb-job-<id>`, which the spend ingester turns into the job's cost.
LiteLLM checks a key's budget before each call against an estimate, so a very small budget can stop the first
call (seen live: blocked at $0.00008 spent of a $0.01 budget).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import hostprobe_client, user_settings
from app.agents import AgentRegistry
from app.litellm_admin import LiteLLMAdmin, LiteLLMError
from app.models import Job

log = logging.getLogger("app.overflow")

ALIAS_PREFIX = "sb-overflow-job-"
TAG = "switchboard-overflow"
MIN_BUDGET_USD = 0.05  # below this LiteLLM's per-call estimate can refuse the first call


class OverflowError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def month_start() -> datetime:
    t = datetime.now(UTC)
    return t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def settings(session: AsyncSession) -> dict[str, Any]:
    o = await user_settings.load(session)
    return {
        "enabled": bool(o.get("overflow_enabled", False)),
        "monthly_usd": float(o["overflow_monthly_usd"])
        if o.get("overflow_monthly_usd") is not None
        else None,
        "model": o.get("overflow_model") or None,
    }


async def spent_this_month(session: AsyncSession) -> float:
    total = await session.scalar(
        select(func.coalesce(func.sum(Job.cost_usd), 0)).where(
            Job.paid.is_(True), Job.created_at >= month_start()
        )
    )
    return float(total or 0)


async def status(session: AsyncSession) -> dict[str, Any]:
    s = await settings(session)
    spent = await spent_this_month(session)
    left = max(0.0, s["monthly_usd"] - spent) if s["monthly_usd"] is not None else None
    ready = bool(s["enabled"] and s["model"] and left is not None and left >= MIN_BUDGET_USD)
    return {
        **s,
        "spent_usd": round(spent, 6),
        "left_usd": None if left is None else round(left, 6),
        "ready": ready,
    }


async def check(session: AsyncSession, budget_usd: float) -> None:
    """Refuse a paid job you can't have: off, no model, or more than this month's overflow budget left."""
    st = await status(session)
    if not st["enabled"]:
        raise OverflowError(409, "Paid overflow is off (Settings → Subscriptions → Paid overflow)")
    if not st["model"]:
        raise OverflowError(409, "Choose the paid model first (Settings → Subscriptions → Paid overflow)")
    if budget_usd < MIN_BUDGET_USD:
        raise OverflowError(400, f"A paid job needs a budget of at least ${MIN_BUDGET_USD:.2f}")
    if st["left_usd"] is None or budget_usd > st["left_usd"] + 1e-9:
        raise OverflowError(
            409, f"That is more than this month's paid-overflow budget left (${st['left_usd'] or 0:.2f})"
        )


def alias(job: Job) -> str:
    return f"{ALIAS_PREFIX}{job.id}-r{job.run_index}-a{job.attempt}"


async def start_run_key(
    session: AsyncSession, reg: AgentRegistry, job: Job, agent_id: str, admin: LiteLLMAdmin | None = None
) -> tuple[str, str]:
    """Create this run's key and its file. Returns (the file's absolute path on the host, the model)."""
    st = await status(session)
    if not st["ready"] or not st["model"]:
        raise OverflowError(409, "Paid overflow is off or has no budget left this month")
    left_job = float(job.paid_budget_usd or 0) - float(job.cost_usd or 0)
    budget = min(left_job, float(st["left_usd"] or 0))
    if budget < MIN_BUDGET_USD:
        raise OverflowError(409, f"The job's paid budget is used up (${float(job.paid_budget_usd or 0):.2f})")
    minutes = reg.defaults.job_timeout_s // 60 + reg.defaults.key_margin_minutes
    own = admin is None
    admin = admin or LiteLLMAdmin()
    try:
        await revoke(job, admin)  # a run restarted after a crash must not leave its old key behind
        key = await admin.generate_key(
            alias=alias(job),
            models=[st["model"]],
            max_budget=budget,
            minutes=minutes,
            tags=[TAG, f"sb-job-{job.id}"],
        )
        code, res = await hostprobe_client.call("POST", "/overflow-key", {"agent": agent_id, "key": key})
        del key
        if code != 200:
            await revoke(job, admin)
            raise OverflowError(502, f"Couldn't hand the paid key to the agent: {res.get('error')}")
        path = res.get("abs_path")
        if not isinstance(path, str) or not path.startswith("/"):
            await revoke(job, admin)
            raise OverflowError(502, "hostprobe didn't say where the paid key file is")
        return path, str(st["model"])
    finally:
        if own:
            await admin.aclose()


async def revoke(job: Job, admin: LiteLLMAdmin | None = None) -> float:
    """Delete every key of this job (any run) and return what they spent. Idempotent."""
    own = admin is None
    admin = admin or LiteLLMAdmin()
    try:
        prefix = f"{ALIAS_PREFIX}{job.id}-"
        keys = [k for k in await admin.keys() if str(k.get("alias") or "").startswith(prefix)]
        await admin.delete_keys([k["token"] for k in keys])
        return sum(k["spend"] for k in keys)
    finally:
        if own:
            await admin.aclose()


async def end_run(job: Job, agent_id: str) -> float:
    """After a paid run (any outcome): revoke its key, remove its file. Returns the run's spend."""
    spent = 0.0
    try:
        spent = await revoke(job)
    except LiteLLMError as e:
        log.warning("job %s: overflow key not revoked yet (the sweep retries): %s", job.id, e)
    code, res = await hostprobe_client.call("POST", "/overflow-key/remove", {"agent": agent_id})
    if code != 200:
        log.warning(
            "job %s: overflow key file not removed yet (the sweep retries): %s", job.id, res.get("error")
        )
    return spent


async def sweep(session: AsyncSession, running_paid: set[tuple[int, str]]) -> int:
    """Remove keys and key files that no running paid job owns (crash recovery). Returns how many went."""
    gone = 0
    admin = LiteLLMAdmin()
    try:
        keep = {f"{ALIAS_PREFIX}{jid}-" for jid, _ in running_paid}
        stale = [
            k
            for k in await admin.keys()
            if str(k.get("alias") or "").startswith(ALIAS_PREFIX)
            and not any(str(k["alias"]).startswith(p) for p in keep)
        ]
        await admin.delete_keys([k["token"] for k in stale])
        gone += len(stale)
    except LiteLLMError as e:
        log.info("overflow sweep: LiteLLM not reachable (%s); will retry", e)
    finally:
        await admin.aclose()
    code, res = await hostprobe_client.call("GET", "/overflow-keys")
    if code == 200:
        busy = {a for _, a in running_paid}
        for agent in res.get("agents") or []:
            if agent not in busy:
                c2, _ = await hostprobe_client.call("POST", "/overflow-key/remove", {"agent": agent})
                gone += c2 == 200
    return gone
