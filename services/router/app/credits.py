"""One-time free credits (providers.yaml `billing: credits`, e.g. Cerebras).

Not a renewing free tier: you enter the starting balance, and every answered call subtracts its list
price (`costs.list_price_usd`, recorded since the balance was set). When the balance reaches $0 the
router stops routing to the provider (and reconcile drops its LiteLLM deployments) until you enter a
new balance. Without a balance entered nothing is blocked; the card asks for one.

The balance is stored as one JSON row in `system_meta` (`credits:<provider>`); no migration needed.
"""

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Cost, SystemMeta
from app.registry import Provider, Registry


def key(provider: str) -> str:
    return f"credits:{provider}"


def is_credits(p: Provider | None) -> bool:
    return bool(p and p.billing == "credits")


async def set_balance(session: AsyncSession, provider: str, starting_usd: float) -> dict[str, Any]:
    """Record a new starting balance; spend counts from now on."""
    state = {"starting_usd": round(float(starting_usd), 6), "set_at": datetime.now(UTC).isoformat()}
    row = await session.get(SystemMeta, key(provider))
    if row is None:
        session.add(SystemMeta(key=key(provider), value=json.dumps(state)))
    else:
        row.value = json.dumps(state)
    await session.flush()
    return state


async def clear_balance(session: AsyncSession, provider: str) -> None:
    row = await session.get(SystemMeta, key(provider))
    if row is not None:
        await session.delete(row)


async def status(session: AsyncSession, provider: str) -> dict[str, Any] | None:
    """None when no balance was entered; else starting, spent, remaining and whether it is used up."""
    row = await session.get(SystemMeta, key(provider))
    if row is None:
        return None
    try:
        data = json.loads(row.value)
        starting = float(data["starting_usd"])
        since = datetime.fromisoformat(data["set_at"])
    except (ValueError, KeyError, TypeError):
        return None
    spent = await session.scalar(
        select(func.coalesce(func.sum(Cost.list_price_usd), 0)).where(
            Cost.provider == provider, Cost.created_at >= since
        )
    )
    spent = float(spent or 0)
    remaining = max(0.0, starting - spent)
    return {
        "starting_usd": starting,
        "spent_usd": round(spent, 6),
        "remaining_usd": round(remaining, 6),
        "exhausted": starting - spent <= 0,
        "set_at": data["set_at"],
    }


async def exhausted(session: AsyncSession, registry: Registry) -> dict[str, str]:
    """provider id -> reason, for credit providers whose entered balance is used up."""
    out: dict[str, str] = {}
    for p in registry.providers.values():
        if not is_credits(p):
            continue
        st = await status(session, p.id)
        if st and st["exhausted"]:
            out[p.id] = (
                f"{p.name} credits are used up ($0 left of ${st['starting_usd']:.2f}); "
                "enter a new balance to use it again"
            )
    return out
