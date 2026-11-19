"""Router-side cooldowns (SPEC §7.1 step 5): targets that just answered 429 or timed out are skipped
for a while so the next request goes straight to a fallback.

M3a: kept in the Router DB (`cooldowns`) too, so a restart doesn't forget a rate limit and the Status
view can say "rate-limited until 14:05". Reads stay in memory (the engine is synchronous); writes are
queued and flushed by `persist()` after each turn, and `load()` restores them at startup.
"""

import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CooldownRow

RATE_LIMIT_S = 60
TIMEOUT_S = 30
ERROR_S = 15
CREDIT_S = 1800  # out of credit: nothing changes until the user adds some
NOT_FOUND_S = 6 * 3600  # the provider retired the model: wait for the next catalog refresh


@dataclass
class Cooldown:
    until: float  # wall clock (time.time()), so it survives a restart
    reason: str
    code: str
    provider: str | None = None

    @property
    def until_iso(self) -> str:
        return datetime.fromtimestamp(self.until, UTC).isoformat()


class Cooldowns:
    def __init__(self) -> None:
        self._by_target: dict[str, Cooldown] = {}
        self._dirty: set[str] = set()

    def set(self, target: str, code: str, reason: str, seconds: float, provider: str | None = None) -> None:
        self._by_target[target] = Cooldown(time.time() + seconds, reason, code, provider)
        self._dirty.add(target)

    def get(self, target: str) -> Cooldown | None:
        c = self._by_target.get(target)
        if c and c.until <= time.time():
            self._by_target.pop(target, None)
            return None
        return c

    def remaining(self, target: str) -> int:
        c = self.get(target)
        return max(0, int(c.until - time.time())) if c else 0

    def clear(self) -> None:
        self._by_target.clear()
        self._dirty.clear()

    def active(self) -> dict[str, Cooldown]:
        """Targets cooling down right now (expired ones are dropped)."""
        return {t: c for t in list(self._by_target) if (c := self.get(t)) is not None}

    async def persist(self, session: AsyncSession) -> None:
        """Write queued cooldowns and drop expired rows. Commits."""
        now = datetime.now(UTC)
        for target in list(self._dirty):
            c = self._by_target.get(target)
            if c is None:
                continue
            until = datetime.fromtimestamp(c.until, UTC)
            stmt = insert(CooldownRow).values(
                target=target, provider=c.provider, code=c.code, reason=c.reason, until=until
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["target"],
                set_={"provider": c.provider, "code": c.code, "reason": c.reason, "until": until},
            )
            await session.execute(stmt)
        self._dirty.clear()
        await session.execute(delete(CooldownRow).where(CooldownRow.until <= now))
        await session.commit()

    async def load(self, session: AsyncSession) -> int:
        now = datetime.now(UTC)
        rows = (await session.execute(select(CooldownRow).where(CooldownRow.until > now))).scalars()
        n = 0
        for r in rows:
            self._by_target[r.target] = Cooldown(r.until.timestamp(), r.reason, r.code, r.provider)
            n += 1
        return n


cooldowns = Cooldowns()
