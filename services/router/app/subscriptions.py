"""Subscription usage windows (M6.5, ADR 0014): reported first, estimated honestly.

Claude Pro, ChatGPT (Codex) and the like limit use in rolling windows ("5-hour", "weekly"). Switchboard reads
what the CLI itself reports and keeps the latest reading per (cli, account, window) in `usage_windows`:

- **Claude Code** prints a `rate_limit_event` in its stream-json output (verified on 2.1.326): per window the
  share used (`utilization`), the reset time and whether it is allowed or rejected. It is read live while a
  job runs (`job_output.TurnCounter`).
- **Codex** doesn't print it, but its own session file for the run does (verified on 0.170.0): hostprobe reads
  only those numbers by the run's thread id (ADR 0014, the one read-only exception to the login-folder rule).

When nothing was reported, or the reported window has reset since, the reading is an **estimate** from our
own runs on that account: consumption in the window (list price for Claude, tokens for Codex) divided by a
capacity learned from the last report (`capacity ≈ our consumption in that window / share used`). Without a
calibration there is no percentage at all, only "N runs in the last 5 hours". Our runs aren't everything
(the owner may use the CLI by hand), so an estimate is always labelled as one.

The guard (`guard`) steers work before the limit, like the API quota guard: at `save_at` light jobs go to the
next agent, at `block_at` (or when the CLI says rejected) every job does, until the reset.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.accounts import DEFAULT, key
from app.agents import AgentDef, AgentRegistry, CliDef
from app.models import Cost, Job, UsageWindow

STALE_AFTER = timedelta(minutes=30)  # a report older than this, with runs since, becomes an estimate
MIN_CALIBRATION = 0.05  # a share used below this is too small to learn a capacity from


def now() -> datetime:
    return datetime.now(UTC)


def _ts(v: Any) -> datetime | None:
    if isinstance(v, int | float) and not isinstance(v, bool) and v > 0:
        return datetime.fromtimestamp(float(v), UTC)
    return None


def _share(v: Any, scale: float = 1.0) -> float | None:
    if isinstance(v, int | float) and not isinstance(v, bool):
        return max(0.0, min(1.0, float(v) / scale))
    return None


@dataclass
class Reading:
    """One window as the CLI reported it."""

    window: str
    used: float | None
    resets_at: datetime | None
    limited: bool
    hours: float | None = None


def parse_claude(ev: dict[str, Any]) -> list[Reading]:
    """A Claude Code `rate_limit_event` -> readings (empty if it isn't one)."""
    if not isinstance(ev, dict) or ev.get("type") != "rate_limit_event":
        return []
    info = ev.get("rate_limit_info")
    if not isinstance(info, dict):
        return []
    top_rejected = info.get("status") == "rejected"
    out: list[Reading] = []
    unified = info.get("unifiedWindows")
    if isinstance(unified, dict):
        for wid, w in unified.items():
            if not isinstance(w, dict):
                continue
            limited = w.get("status") == "rejected" or (top_rejected and info.get("rateLimitType") == wid)
            used = _share(w.get("utilization"))
            out.append(Reading(str(wid), 1.0 if limited else used, _ts(w.get("resetsAt")), limited))
    elif isinstance(info.get("rateLimitType"), str):
        out.append(
            Reading(
                info["rateLimitType"],
                1.0 if top_rejected else _share(info.get("utilization")),
                _ts(info.get("resetsAt")),
                top_rejected,
            )
        )
    if top_rejected and not any(r.limited for r in out):  # rejected without saying which window
        wid = str(info.get("rateLimitType") or "five_hour")
        out.append(Reading(wid, 1.0, _ts(info.get("resetsAt")), True))
    return out


def parse_codex(data: dict[str, Any]) -> list[Reading]:
    """hostprobe's `/codex/usage` answer (numbers only) -> readings."""
    if not isinstance(data, dict) or not data.get("found"):
        return []
    out = []
    for wid in ("primary", "secondary"):
        w = data.get(wid)
        if not isinstance(w, dict):
            continue
        used = _share(w.get("used_percent"), 100.0)
        minutes = w.get("window_minutes")
        hours = float(minutes) / 60 if isinstance(minutes, int | float) and minutes > 0 else None
        limited = bool(data.get("limit_reached")) and wid == "primary" or (used is not None and used >= 1.0)
        out.append(Reading(wid, used, _ts(w.get("resets_at")), limited, hours))
    return out


def hours_label(hours: float) -> str:
    """5 -> "5-hour", 168 -> "7-day", 720 -> "30-day"."""
    if hours >= 24 and abs(hours / 24 - round(hours / 24)) < 0.01:
        return f"{round(hours / 24)}-day"
    return f"{hours:g}-hour"


# --- what our own runs used -----------------------------------------------------------------------------
def _agent_ids(reg: AgentRegistry, cli: str) -> list[str]:
    return [a.id for a in [*reg.agents.values(), *reg.retired.values()] if a.cli == cli and not a.paid]


async def consumption(
    session: AsyncSession, reg: AgentRegistry, cli: CliDef, account: str | None, since: datetime
) -> tuple[float, int]:
    """(units, runs) our jobs used on this CLI account since `since`: list price or tokens."""
    unit = (
        func.coalesce(Cost.list_price_usd, 0)
        if cli.estimate_by == "list_price"
        else func.coalesce(Cost.tokens_in, 0) + func.coalesce(Cost.tokens_out, 0)
    )
    acct = Job.account.is_(None) if key(account) == DEFAULT else Job.account == account
    row = (
        await session.execute(
            select(func.coalesce(func.sum(unit), 0), func.count(Cost.id))
            .join(Job, Job.id == Cost.job_id)
            .where(
                Cost.source == "paperclip",
                Cost.created_at >= since,
                Job.agent.in_(_agent_ids(reg, cli.id)),
                acct,
            )
        )
    ).one()
    return float(row[0] or 0), int(row[1] or 0)


# --- storing readings -----------------------------------------------------------------------------------
async def record(
    session: AsyncSession, reg: AgentRegistry, cli_id: str, account: str | None, readings: list[Reading]
) -> None:
    """Upsert the reported windows and learn each one's capacity (our consumption ÷ share used)."""
    cli = reg.clis.get(cli_id)
    if cli is None or not readings:
        return
    t = now()
    for r in readings:
        hours = r.hours or (cli.window(r.window).hours if cli.window(r.window) else None)
        capacity = None
        if r.used is not None and r.used >= MIN_CALIBRATION and r.resets_at and hours:
            units, _ = await consumption(session, reg, cli, account, r.resets_at - timedelta(hours=hours))
            if units > 0:
                capacity = units / r.used
        values = {
            "cli": cli_id,
            "account": key(account),
            "window": r.window,
            "used": r.used,
            "resets_at": r.resets_at,
            "limited": r.limited,
            "source": "reported",
            "hours": hours,
            "seen_at": t,
        }
        update = {k: v for k, v in values.items() if k not in ("cli", "account", "window")}
        if capacity is not None:
            values["capacity"] = update["capacity"] = capacity
        await session.execute(
            insert(UsageWindow)
            .values(**values)
            .on_conflict_do_update(index_elements=["cli", "account", "window"], set_=update)
        )
    await session.commit()


async def record_limit(
    session: AsyncSession, reg: AgentRegistry, cli_id: str, account: str | None, resets_at: datetime | None
) -> datetime:
    """A run ended on a usage limit without a usable reading: mark the first window limited until the
    reported (else configured) reset. Returns that reset time."""
    cli = reg.clis[cli_id]
    w = cli.windows[0]
    until = resets_at or now() + timedelta(hours=w.hours)
    existing = await session.get(UsageWindow, (cli_id, key(account), w.id))
    src = "reported" if resets_at else "estimate"
    if existing is None:
        session.add(
            UsageWindow(
                cli=cli_id,
                account=key(account),
                window=w.id,
                used=1.0,
                resets_at=until,
                limited=True,
                source=src,
                hours=w.hours,
                seen_at=now(),
            )
        )
    else:
        existing.used, existing.resets_at, existing.limited = 1.0, until, True
        existing.source, existing.seen_at = src, now()
    await session.commit()
    return until


# --- reading them back ----------------------------------------------------------------------------------
async def windows(
    session: AsyncSession, reg: AgentRegistry, cli: CliDef, account: str | None
) -> list[dict[str, Any]]:
    """Every configured (and reported) window of one account, as the UI shows it."""
    rows = {
        r.window: r
        for r in (
            await session.scalars(
                select(UsageWindow).where(UsageWindow.cli == cli.id, UsageWindow.account == key(account))
            )
        ).all()
    }
    ids = [w.id for w in cli.windows] + [w for w in rows if not cli.window(w)]
    if cli.usage == "session_file" and any(r.source == "reported" for r in rows.values()):
        # Codex reports which windows the plan has (the free plan: one 30-day window); configured fallbacks it
        # didn't report are not shown.
        ids = [w for w in ids if w in rows]
    t = now()
    out = []
    for wid in ids:
        row = rows.get(wid)
        wdef = cli.window(wid)
        hours = (row.hours if row and row.hours else None) or (wdef.hours if wdef else 5.0)
        # Codex says how long its windows are (`window_minutes`): name them by that ("5-hour", "30-day").
        label = (
            hours_label(row.hours)
            if row is not None and row.hours and cli.usage == "session_file"
            else (wdef.label if wdef else wid)
        )
        view: dict[str, Any] = {
            "window": wid,
            "label": label,
            "hours": hours,
            "used": None,
            "resets_at": None,
            "limited": False,
            "source": "estimate",
            "runs": 0,
            "seen_at": row.seen_at.isoformat() if row else None,
        }
        live = row is not None and row.resets_at is not None and row.resets_at > t
        if live:
            assert row is not None
            view.update(used=row.used, resets_at=row.resets_at.isoformat(), limited=bool(row.limited))
            view["source"] = row.source
            if row.source == "reported" and t - row.seen_at > STALE_AFTER and row.capacity:
                more, runs = await consumption(session, reg, cli, account, row.seen_at)
                if runs:
                    view["used"] = min(1.0, (row.used or 0) + more / row.capacity)
                    view["source"] = "estimate"
        else:
            since = (
                max(row.resets_at, t - timedelta(hours=hours))
                if row and row.resets_at
                else t - timedelta(hours=hours)
            )
            units, runs = await consumption(session, reg, cli, account, since)
            view["runs"] = runs
            if row is not None and row.capacity:
                view["used"] = min(1.0, units / row.capacity)
            elif runs == 0 and row is not None:
                view["used"] = 0.0  # the window reset and nothing ran since
        out.append(view)
    return out


def tightest(views: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The window that matters most now: a limited one, else the fullest known one."""
    if not views:
        return None
    limited = [v for v in views if v["limited"]]
    if limited:
        return max(limited, key=lambda v: v["resets_at"] or "")
    known = [v for v in views if v["used"] is not None]
    return max(known, key=lambda v: v["used"]) if known else views[0]


async def overview(session: AsyncSession, reg: AgentRegistry, accounts_by_cli: dict[str, list[str]]) -> list:
    out = []
    for cli in reg.clis.values():
        for name in accounts_by_cli.get(cli.id, [DEFAULT]):
            views = await windows(session, reg, cli, name)
            out.append(
                {
                    "cli": cli.id,
                    "label": cli.label,
                    "account": name,
                    "windows": views,
                    "tightest": tightest(views),
                }
            )
    return out


# --- the guard ------------------------------------------------------------------------------------------
class WindowReason(str):
    """An agent_check reason caused only by a usage window: the job can wait for `until`, not fail."""

    until: datetime | None = None

    def __new__(cls, text: str, until: datetime | None):
        obj = super().__new__(cls, text)
        obj.until = until
        return obj


def is_light(reg: AgentRegistry, autonomy: int, rule_id: str | None) -> bool:
    g = reg.defaults.guard
    if autonomy in g.light_levels:
        return True
    return rule_id is not None and rule_id not in g.heavy_rules


def _until(view: dict[str, Any]) -> datetime | None:
    v = view.get("resets_at")
    return datetime.fromisoformat(v) if v else None


async def guard(
    session: AsyncSession, reg: AgentRegistry, agent: AgentDef, account: str | None, light: bool
) -> WindowReason | None:
    cli = reg.subscription(agent)
    if cli is None:
        return None
    views = await windows(session, reg, cli, account)
    who = f"{agent.label}" + (f" ({account})" if key(account) != DEFAULT else "")
    for v in views:
        if v["limited"]:
            return WindowReason(f"{who} hit its {v['label']} usage limit; it resets later", _until(v))
    t = tightest(views)
    if t is None or t["used"] is None:
        return None
    g = reg.defaults.guard
    pct = round(t["used"] * 100)
    if t["used"] >= g.block_at:
        return WindowReason(f"{who} used its {t['label']} window ({pct}%)", _until(t))
    if light and t["used"] >= g.save_at:
        return WindowReason(
            f"{who} is at {pct}% of its {t['label']} window: saving it for heavy work", _until(t)
        )
    return None
