"""Quota guard (M3a): count requests and tokens per provider/model per minute and per day against the
free limits in providers.yaml (`limits:`), and read provider rate-limit headers when they come back.
Automatic routing moves elsewhere at `quota.reroute_at` (rules.yaml, 80%) of any window, before the
provider answers 429; manual picks may use the rest.

Counters live in the Router DB (`quota_usage`), so a restart doesn't reset them. The engine only sees
a `QuotaView` snapshot built per request (`load_view`), which keeps `decide()` pure.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import QuotaHeaders, QuotaUsage
from app.registry import Provider, Registry

log = logging.getLogger("app.quota")

WINDOWS = ("rpm", "rpd", "tpm", "tpd")
KEEP_DAYS = 3


@dataclass(frozen=True)
class Limit:
    rpm: int | None = None
    rpd: int | None = None
    tpm: int | None = None
    tpd: int | None = None

    def merged(self, o: Mapping[str, Any]) -> Limit:
        vals = {w: getattr(self, w) for w in WINDOWS}
        vals.update({w: int(o[w]) for w in WINDOWS if o.get(w) is not None})
        return Limit(**vals)

    def any(self) -> bool:
        return any(getattr(self, w) for w in WINDOWS)


@dataclass(frozen=True)
class Policy:
    scope: str  # model | provider
    only_free: bool
    tz: str
    default: Limit
    models: dict[str, Limit] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)  # requests/tokens -> minute | day
    estimate: bool = False


def _test_overrides() -> dict[tuple[str, str], dict[str, int]]:
    """ROUTER_QUOTA_TEST_LIMITS="groq:openai/gpt-oss-120b=rpd:3,rpm:10;openrouter:*=rpd:2" (dev only)."""
    raw = get_settings().router_quota_test_limits.strip()
    out: dict[tuple[str, str], dict[str, int]] = {}
    for part in filter(None, (p.strip() for p in raw.split(";"))):
        try:
            target, spec = part.split("=", 1)
            provider, scope = target.split(":", 1)
            vals = {k.strip(): int(v) for k, v in (kv.split(":") for kv in spec.split(","))}
        except ValueError:
            log.warning("ignoring malformed ROUTER_QUOTA_TEST_LIMITS entry %r", part)
            continue
        if set(vals) <= set(WINDOWS):
            out[(provider.strip(), scope.strip())] = vals
    return out


def policy(p: Provider) -> Policy | None:
    raw = p.limits
    tests = {k: v for k, v in _test_overrides().items() if k[0] == p.id}
    if not raw and not tests:
        return None
    default = Limit().merged(raw.get("default") or {})
    models = {str(m): default.merged(v or {}) for m, v in (raw.get("models") or {}).items()}
    scope = str(raw.get("scope") or "model")
    for (_, key), vals in tests.items():
        if key == "*":
            default = default.merged(vals)
            models = {m: lim.merged(vals) for m, lim in models.items()}
        else:
            models[key] = models.get(key, default).merged(vals)
    hdr = {str(k): str(v) for k, v in (raw.get("headers") or {}).items()}
    if p.id == "groq" and not hdr:  # documented: requests = per day, tokens = per minute
        hdr = {"requests": "day", "tokens": "minute"}
    return Policy(
        scope=scope if scope in ("model", "provider") else "model",
        only_free=bool(raw.get("only_free", False)),
        tz=str(raw.get("day_reset_tz") or "UTC"),
        default=default,
        models=models,
        headers=hdr or {"requests": "minute", "tokens": "minute"},
        estimate=bool(raw.get("estimate", False)),
    )


def scope_of(p: Provider, pol: Policy, model_id: str) -> str | None:
    """Counter key for a call, or None when the limits don't apply (a paid OpenRouter model)."""
    if pol.only_free and not p.is_free_tier(model_id):
        return None
    return "*" if pol.scope == "provider" else model_id


def limit_of(pol: Policy, model_id: str) -> Limit:
    return pol.models.get(model_id, pol.default)


# --- windows ------------------------------------------------------------------------------------
def minute_start(now: datetime) -> datetime:
    return now.replace(second=0, microsecond=0)


def day_start(now: datetime, tz: str) -> datetime:
    try:
        zone = ZoneInfo(tz)
    except Exception:  # unknown zone name in providers.yaml -> UTC
        zone = ZoneInfo("UTC")
    local = now.astimezone(zone)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


def next_day_start(now: datetime, tz: str) -> datetime:
    return day_start(day_start(now, tz) + timedelta(hours=36), tz)


_DUR = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


def parse_reset(v: str | None) -> float | None:
    """Groq's `1m26.4s` / `577ms` / `2s`, or plain seconds -> seconds."""
    if not v:
        return None
    v = v.strip()
    try:
        return float(v)
    except ValueError:
        pass
    total, found = 0.0, False
    for num, unit in _DUR.findall(v):
        found = True
        total += float(num) * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]
    return total if found else None


# --- the snapshot the engine reads ----------------------------------------------------------------
@dataclass(frozen=True)
class Usage:
    fraction: float
    window: str  # minute | day
    kind: str  # requests | tokens
    used: int
    limit: int
    resets_at: datetime | None
    source: str  # counter | headers
    estimate: bool = False

    def describe(self) -> str:
        pct = int(round(self.fraction * 100))
        what = "today's" if self.window == "day" else "its per-minute"
        tok = " token" if self.kind == "tokens" else ""
        return f"at {pct}% of {what}{tok} limit ({self.used}/{self.limit})"

    def as_dict(self) -> dict[str, Any]:
        return {
            "fraction": round(self.fraction, 3),
            "window": self.window,
            "kind": self.kind,
            "used": self.used,
            "limit": self.limit,
            "resets_at": self.resets_at.isoformat() if self.resets_at else None,
            "source": self.source,
            "estimate": self.estimate,
        }


@dataclass
class QuotaView:
    registry: Registry
    now: datetime
    counters: dict[tuple[str, str, str, datetime], tuple[int, int]] = field(default_factory=dict)
    headers: dict[tuple[str, str], tuple[dict[str, Any], datetime]] = field(default_factory=dict)

    def _count(self, provider: str, key: str, window: str, start: datetime) -> tuple[int, int]:
        return self.counters.get((provider, key, window, start), (0, 0))

    def windows(self, provider: str, model_id: str) -> list[Usage]:
        p = self.registry.providers.get(provider)
        pol = policy(p) if p else None
        if p is None or pol is None:
            return []
        key = scope_of(p, pol, model_id)
        if key is None:
            return []
        return self.windows_for(provider, pol, key, limit_of(pol, model_id))

    def windows_for(self, provider: str, pol: Policy, key: str, lim: Limit) -> list[Usage]:
        now = self.now
        m0 = minute_start(now)
        cur_r, cur_t = self._count(provider, key, "m", m0)
        prev_r, prev_t = self._count(provider, key, "m", m0 - timedelta(minutes=1))
        weight = 1 - (now - m0).total_seconds() / 60
        d0 = day_start(now, pol.tz)
        day_r, day_t = self._count(provider, key, "d", d0)
        out: list[Usage] = []

        def add(limit: int | None, used: float, window: str, kind: str, resets: datetime) -> None:
            if limit:
                out.append(
                    Usage(
                        used / limit, window, kind, int(round(used)), limit, resets, "counter", pol.estimate
                    )
                )

        add(lim.rpm, cur_r + prev_r * weight, "minute", "requests", m0 + timedelta(minutes=1))
        add(lim.tpm, cur_t + prev_t * weight, "minute", "tokens", m0 + timedelta(minutes=1))
        add(lim.rpd, day_r, "day", "requests", next_day_start(now, pol.tz))
        add(lim.tpd, day_t, "day", "tokens", next_day_start(now, pol.tz))
        hit = self.headers.get((provider, key))
        if hit:
            data, seen = hit
            for kind in ("requests", "tokens"):
                limit, remaining = data.get(f"limit_{kind}"), data.get(f"remaining_{kind}")
                reset_s = data.get(f"reset_{kind}_s")
                if not limit or remaining is None:
                    continue
                resets = seen + timedelta(seconds=reset_s) if reset_s is not None else None
                if resets and resets <= now:
                    continue  # the window this snapshot describes is over
                used = max(0, int(limit) - int(remaining))
                window = pol.headers.get(kind, "minute")
                out.append(Usage(used / int(limit), window, kind, used, int(limit), resets, "headers"))
        return out

    def usage(self, provider: str, model_id: str) -> Usage | None:
        """The window closest to its limit (what decides rerouting)."""
        ws = self.windows(provider, model_id)
        return max(ws, key=lambda u: u.fraction) if ws else None

    def headroom(self, provider: str, model_id: str) -> float:
        u = self.usage(provider, model_id)
        return 1.0 if u is None else max(0.0, 1.0 - u.fraction)


async def load_view(session: AsyncSession, registry: Registry, now: datetime | None = None) -> QuotaView:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=2)
    rows = (await session.execute(select(QuotaUsage).where(QuotaUsage.window_start >= since))).scalars()
    counters = {(r.provider, r.scope_key, r.window, r.window_start): (r.requests, r.tokens) for r in rows}
    headers = {
        (h.provider, h.scope_key): (h.data or {}, h.seen_at)
        for h in (await session.execute(select(QuotaHeaders))).scalars()
    }
    return QuotaView(registry, now, counters, headers)


# --- recording ------------------------------------------------------------------------------------
async def _bump(
    session: AsyncSession, provider: str, key: str, window: str, start: datetime, req: int, tok: int
) -> None:
    stmt = insert(QuotaUsage).values(
        provider=provider, scope_key=key, window=window, window_start=start, requests=req, tokens=tok
    )
    stmt = stmt.on_conflict_do_update(
        constraint="uq_quota_bucket",
        set_={"requests": QuotaUsage.requests + req, "tokens": QuotaUsage.tokens + tok},
    )
    await session.execute(stmt)


async def record(
    session: AsyncSession,
    registry: Registry,
    provider: str,
    model_id: str,
    requests: int = 0,
    tokens: int = 0,
    now: datetime | None = None,
) -> None:
    """Count one attempt (requests=1, before the call) or its tokens (after). No commit."""
    p = registry.providers.get(provider)
    pol = policy(p) if p else None
    if p is None or pol is None or (requests == 0 and tokens == 0):
        return
    key = scope_of(p, pol, model_id)
    if key is None:
        return
    now = now or datetime.now(UTC)
    await _bump(session, provider, key, "m", minute_start(now), requests, tokens)
    await _bump(session, provider, key, "d", day_start(now, pol.tz), requests, tokens)


HEADER_NAMES = {
    "limit_requests": ("x-ratelimit-limit-requests", "x-ratelimit-limit"),
    "remaining_requests": ("x-ratelimit-remaining-requests", "x-ratelimit-remaining"),
    "reset_requests": ("x-ratelimit-reset-requests", "x-ratelimit-reset"),
    "limit_tokens": ("x-ratelimit-limit-tokens",),
    "remaining_tokens": ("x-ratelimit-remaining-tokens",),
    "reset_tokens": ("x-ratelimit-reset-tokens",),
}


def parse_headers(h: Mapping[str, str]) -> dict[str, Any]:
    """x-ratelimit-* (also LiteLLM's `llm_provider-` copies) -> numbers. Empty when none present."""
    low = {k.lower().removeprefix("llm_provider-"): v for k, v in h.items()}
    out: dict[str, Any] = {}
    for field_name, names in HEADER_NAMES.items():
        v = next((low[n] for n in names if n in low), None)
        if v is None:
            continue
        if field_name.startswith("reset"):
            secs = parse_reset(v)
            if secs is not None and secs > 10**9:  # epoch (ms or s), OpenRouter style
                secs = (secs / 1000 if secs > 10**12 else secs) - datetime.now(UTC).timestamp()
            if secs is not None:
                out[f"{field_name}_s"] = max(0.0, secs)
        else:
            try:
                out[field_name] = int(float(v))
            except ValueError:
                continue
    return out if any(k.startswith(("limit", "remaining")) for k in out) else {}


async def record_headers(
    session: AsyncSession, registry: Registry, provider: str, model_id: str, h: Mapping[str, str]
) -> None:
    data = parse_headers(h)
    p = registry.providers.get(provider)
    pol = policy(p) if p else None
    if not data or p is None or pol is None:
        return
    key = scope_of(p, pol, model_id)
    if key is None:
        return
    stmt = insert(QuotaHeaders).values(provider=provider, scope_key=key, data=data, seen_at=datetime.now(UTC))
    stmt = stmt.on_conflict_do_update(
        index_elements=["provider", "scope_key"], set_={"data": data, "seen_at": datetime.now(UTC)}
    )
    await session.execute(stmt)


async def prune(session: AsyncSession) -> None:
    cutoff = datetime.now(UTC) - timedelta(days=KEEP_DAYS)
    await session.execute(delete(QuotaUsage).where(QuotaUsage.window_start < cutoff))


def provider_summary(view: QuotaView, connected: set[str]) -> list[dict[str, Any]]:
    """Per provider, the most-used model's closest window (footer / Status / Connections)."""
    out = []
    for pid in sorted(connected):
        p = view.registry.providers.get(pid)
        pol = policy(p) if p else None
        if p is None or pol is None:
            continue
        keys = {k[1] for k in view.counters if k[0] == pid} | {k[1] for k in view.headers if k[0] == pid}
        best: tuple[str, Usage] | None = None
        for key in keys:
            ws = view.windows_for(pid, pol, key, limit_of(pol, key))
            u = max(ws, key=lambda w: w.fraction) if ws else None
            if u and (best is None or u.fraction > best[1].fraction):
                best = (key, u)
        if best:
            out.append(
                {
                    "provider": pid,
                    "name": p.name.split(" (")[0],
                    "model": None if best[0] == "*" else best[0],
                    **best[1].as_dict(),
                }
            )
    return sorted(out, key=lambda r: -r["fraction"])
