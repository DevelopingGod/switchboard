"""Router-side cooldowns (SPEC §7.1 step 5): targets that just answered 429 or timed out are skipped
for a while so the next request goes straight to a fallback. In memory (one router process);
persisting them is an M3 carry-over.
"""

import time
from dataclasses import dataclass

RATE_LIMIT_S = 60
TIMEOUT_S = 30
ERROR_S = 15


@dataclass
class Cooldown:
    until: float
    reason: str
    code: str


class Cooldowns:
    def __init__(self) -> None:
        self._by_target: dict[str, Cooldown] = {}

    def set(self, target: str, code: str, reason: str, seconds: float) -> None:
        self._by_target[target] = Cooldown(time.monotonic() + seconds, reason, code)

    def get(self, target: str) -> Cooldown | None:
        c = self._by_target.get(target)
        if c and c.until <= time.monotonic():
            self._by_target.pop(target, None)
            return None
        return c

    def remaining(self, target: str) -> int:
        c = self.get(target)
        return max(0, int(c.until - time.monotonic())) if c else 0

    def clear(self) -> None:
        self._by_target.clear()


cooldowns = Cooldowns()
