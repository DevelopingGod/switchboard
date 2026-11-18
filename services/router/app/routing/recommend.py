"""Recommender (SPEC §6.4): ranks catalog models for `best:<capability>` targets and dynamic aliases.

Hard filters run in the engine (privacy, capability, context window, budget, quota, cooldown,
connected, OpenRouter `:free` only). This module scores what is left:

    score = Σ weight·term / Σ weight, every term in 0..1 (weights in rules.yaml `recommender:`)

    capability  has the tag; +0.3 when it also has the task's own tag (code → code, ...)
    feedback    thumbs up/down for this task type, Laplace-smoothed: (up+1)/(up+down+2)
    latency     median time to first token: 1 − p50/8 s (unmeasured: 0.5, local: 0.3)
    success     answers without error, smoothed: (ok+1)/(n+2)
    headroom    free quota left (quota guard)
    cost        free/local = 1, else 1/(1 + $/1M tokens)
    privacy     no-training/local 1, varies 0.5, may-train 0.3

A model with fewer than `min_samples` answers is never ranked above a proven one unless the owner turns
on Settings → Routing → Explore new models; then everything competes on score, unmeasured terms
counting as neutral. Deterministic, so tests can pin it.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

TASK_TAG = {"code": "code", "research": "long-context", "writing": "chat", "chat": "fast", "bulk": "fast"}
PRIVACY = {"no-training": 1.0, "local": 1.0, "varies": 0.5, "may-train": 0.3}
LATENCY_SPAN_MS = 8000


@dataclass(frozen=True)
class Stat:
    samples: int = 0
    failures: int = 0
    p50_ms: int | None = None
    up: int = 0
    down: int = 0


@dataclass
class Scored:
    entry: Any  # engine.CatalogEntry
    score: float
    parts: dict[str, float]
    samples: int
    failures: int
    proven: bool
    p50_ms: int | None
    success: float
    up: int
    down: int
    headroom: float
    free: bool
    local: bool
    privacy: str

    def factors(self, weights: Mapping[str, float]) -> list[str]:
        """Plain-language reasons, strongest contribution first."""
        cands: list[tuple[float, str]] = []
        w = weights
        if self.local:
            cands.append((w["privacy"] * 1.0 + 0.01, "Runs on your GPU; nothing leaves the machine"))
        elif self.free:
            cands.append((w["cost"] * self.parts["cost"], "Free tier: costs $0"))
        if self.p50_ms is not None:
            cands.append(
                (w["latency"] * self.parts["latency"], f"Fast: {self.p50_ms} ms to first token (median)")
            )
        if self.samples >= 3:
            pct = round(100 * (self.samples - self.failures) / self.samples)
            cands.append(
                (
                    w["success"] * self.parts["success"],
                    f"{pct}% answered without error ({self.samples} replies)",
                )
            )
        if self.up + self.down:
            cands.append(
                (
                    w["feedback"] * self.parts["feedback"],
                    f"Rated helpful {self.up} of {self.up + self.down} times",
                )
            )
        if self.headroom < 1:
            cands.append(
                (w["headroom"] * self.headroom, f"{int(self.headroom * 100)}% of its free limit left")
            )
        if not self.local and self.privacy == "no-training":
            cands.append((w["privacy"] * 1.0, "Provider does not train on API data"))
        return [text for _, text in sorted(cands, key=lambda t: -t[0])]


def pick_stats(stats: Mapping[str, Stat] | None, task: str) -> tuple[Stat, Stat | None]:
    """(stats for ranking, the 1-token test ping): this task type if it has samples, else all real
    task types together. `test` pings only count for latency."""
    stats = stats or {}
    test = stats.get("test")
    own = stats.get(task)
    if own and own.samples:
        return own, test
    real = [s for k, s in stats.items() if k != "test"]
    if not real:
        return Stat(), test
    total = sum(s.samples for s in real)
    p50s = [s.p50_ms for s in real if s.p50_ms is not None]
    return (
        Stat(
            samples=total,
            failures=sum(s.failures for s in real),
            p50_ms=int(sorted(p50s)[len(p50s) // 2]) if p50s else None,
            up=sum(s.up for s in real),
            down=sum(s.down for s in real),
        ),
        test,
    )


def score_one(
    e: Any,
    *,
    task: str,
    weights: Mapping[str, float],
    min_samples: int,
    free: bool,
    local: bool,
    headroom: float,
) -> Scored:
    st, test = pick_stats(e.stats, task)
    p50 = st.p50_ms if st.p50_ms is not None else (test.p50_ms if test else e.p50_ms)
    tags = set(e.tags)
    parts = {
        "capability": 0.7 + (0.3 if TASK_TAG.get(task) in tags else 0.0),
        "feedback": (st.up + 1) / (st.up + st.down + 2),
        "latency": max(0.0, 1 - p50 / LATENCY_SPAN_MS) if p50 is not None else (0.3 if local else 0.5),
        "success": (st.samples - st.failures + 1) / (st.samples + 2),
        "headroom": headroom,
        "cost": 1.0 if (free or local) else 1 / (1 + ((e.input_per_1m or 0) + (e.output_per_1m or 0)) / 2),
        "privacy": 1.0 if local else PRIVACY.get(e.privacy, 0.5),
    }
    total_w = sum(weights.values()) or 1.0
    score = sum(weights[k] * v for k, v in parts.items()) / total_w
    return Scored(
        entry=e,
        score=round(score, 4),
        parts=parts,
        samples=st.samples,
        failures=st.failures,
        proven=st.samples >= min_samples,
        p50_ms=p50,
        success=parts["success"],
        up=st.up,
        down=st.down,
        headroom=headroom,
        free=free,
        local=local,
        privacy=e.privacy,
    )


def rank(
    pool: Sequence[Any],
    *,
    task: str,
    weights: Mapping[str, float],
    min_samples: int,
    explore: bool,
    is_free: Callable[[Any], bool],
    is_local: Callable[[Any], bool],
    headroom: Callable[[Any], float],
) -> list[Scored]:
    scored = [
        score_one(
            e,
            task=task,
            weights=weights,
            min_samples=min_samples,
            free=is_free(e),
            local=is_local(e),
            headroom=headroom(e),
        )
        for e in pool
    ]
    if explore:
        key = lambda s: (-s.score, s.entry.model_id)  # noqa: E731
    else:  # proven models first (SPEC §6.4: never auto-pick an unproven model over a proven one)
        key = lambda s: (not s.proven, -s.score, s.entry.model_id)  # noqa: E731
    return sorted(scored, key=key)
