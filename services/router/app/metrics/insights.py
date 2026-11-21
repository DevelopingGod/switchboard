"""One plain sentence per insight (M6). Built from the same numbers the dashboard shows, and honest about
money: savings are always "net" (after subscription fees and real spend), never the raw value at API
prices."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

MIN_CHATS = 5  # below this a share is noise
MIN_SHARE = 0.2
MAX = 4


def usd(v: float) -> str:
    v = abs(v)
    if v == 0:
        return "$0"
    if v < 0.01:
        return "less than $0.01"
    return f"${v:,.2f}"


def savings(value: float, fees: float, spent: float, has_subs: bool) -> str | None:
    if value <= 0 and fees <= 0 and spent <= 0:
        return None
    net = value - fees - spent
    if not has_subs:
        if value - spent <= 0:
            return None
        return (
            f"This would have cost {usd(value)} at API prices; you paid {usd(spent)}. "
            "Add your subscriptions in Settings to see what you saved after their fees."
        )
    if net > 0:
        return (
            f"You're {usd(net)} ahead: {usd(value)} of use at API prices, minus {usd(fees)} of subscriptions "
            f"and {usd(spent)} spent."
        )
    if net < 0:
        return (
            "Subscriptions cost more than they saved this period: "
            f"{usd(fees)} in fees and {usd(spent)} spent, against {usd(value)} of use at API prices."
        )
    return f"You broke even: {usd(value)} of use at API prices, the same as your fees and spend."


def free_share(rows: list[dict[str, Any]], names: dict[str, str]) -> str | None:
    total = sum(r["requests"] for r in rows)
    if total < MIN_CHATS:
        return None
    best = max(rows, key=lambda r: r["free"], default=None)
    if not best or best["free"] / total < MIN_SHARE:
        return None
    pct = round(100 * best["free"] / total)
    return f"{names.get(best['provider'], best['provider'])} handled {pct}% of your chats for free."


def reliability(t: dict[str, Any]) -> str | None:
    rl, to, fb = t.get("rate_limited", 0), t.get("timeouts", 0), t.get("fallbacks", 0)
    if not (rl or to):
        return None
    parts = []
    if rl:
        parts.append(f"{rl} rate limit{'s' if rl != 1 else ''} (429)")
    if to:
        parts.append(f"{to} timeout{'s' if to != 1 else ''}")
    tail = f"; {fb} time{'s' if fb != 1 else ''} another model answered instead" if fb else ""
    return f"Providers returned {' and '.join(parts)}{tail}."


def cap_forecast(chat: dict[str, Any], tz: ZoneInfo) -> str | None:
    if chat.get("state") == "reached":
        return f"You've reached today's chat cap ({usd(chat['cap'])}); paid models wait until it resets."
    if chat.get("state") == "will_reach" and chat.get("hits_at"):
        at = datetime.fromisoformat(chat["hits_at"]).astimezone(tz).strftime("%H:%M")
        return f"At this rate you'll reach your daily cap ({usd(chat['cap'])}) at {at}."
    return None


def jobs(rows: list[dict[str, Any]]) -> str | None:
    rows = [r for r in rows if (r.get("jobs_done", 0) + r.get("jobs_failed", 0)) > 0]
    if not rows:
        return None
    top = max(rows, key=lambda r: r["jobs_done"] + r["jobs_failed"])
    n = top["jobs_done"] + top["jobs_failed"]
    return f"{top['label']} finished {top['jobs_done']} of {n} job{'s' if n != 1 else ''}."


def build(
    *,
    totals: dict[str, Any],
    fees: float,
    has_subs: bool,
    free_rows: list[dict[str, Any]],
    names: dict[str, str],
    chat_budget: dict[str, Any] | None,
    job_rows: list[dict[str, Any]],
    tz: ZoneInfo,
) -> list[str]:
    candidates = [
        cap_forecast(chat_budget, tz) if chat_budget else None,
        free_share(free_rows, names),
        savings(totals["value_usd"], fees, totals["spent_usd"], has_subs),
        reliability(totals),
        jobs(job_rows),
    ]
    return [c for c in candidates if c][:MAX]
