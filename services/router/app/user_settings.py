"""Owner settings that override config/rules.yaml defaults (M1.5 Settings page).

rules.yaml is mounted read-only and stays the source of the defaults; these overrides live in
`system_meta` (key `settings`), the same pattern as onboarding and credits. Only three values:
- `max_cost_usd`: per-request cap. Rules with their own lower cap keep it (the stricter one wins).
- `daily_cap_usd`: daily cap (UTC day).
- `private_by_default`: the composer starts new chats with Private on. It is a default, not a lock:
  the person can still switch it off for one chat (a private thread stays private once started).
"""

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SystemMeta

KEY = "settings"
FIELDS = ("max_cost_usd", "daily_cap_usd", "private_by_default")


async def load(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(SystemMeta, KEY)
    if not row:
        return {}
    try:
        data = json.loads(row.value)
    except ValueError:
        return {}
    return {k: data[k] for k in FIELDS if data.get(k) is not None}


async def save(session: AsyncSession, patch: dict[str, Any]) -> dict[str, Any]:
    """Partial update; a value of None removes the override (back to rules.yaml)."""
    cur = await load(session)
    for k, v in patch.items():
        if k not in FIELDS:
            continue
        if v is None:
            cur.pop(k, None)
        else:
            cur[k] = v
    row = await session.get(SystemMeta, KEY)
    if row is None:
        session.add(SystemMeta(key=KEY, value=json.dumps(cur)))
    else:
        row.value = json.dumps(cur)
    await session.commit()
    return cur
