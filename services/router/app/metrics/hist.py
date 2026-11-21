"""Latency histograms with fixed bucket edges, so 15-minute rows merge by adding counts (ADR 0012).

Percentiles from a histogram are approximate: the answer is interpolated inside one bucket, so the error is
at most that bucket's width (≤ 50% of the lower edge above 1 s). Exact percentiles would need every raw row
for the range, which is what the rollups avoid.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Iterable, Sequence

# Upper edges in ms; the last bucket is open (≥ 128 s).
EDGES_MS: tuple[int, ...] = (
    250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 96000,
    128000,
)  # fmt: skip
SIZE = len(EDGES_MS) + 1


def slot(ms: int) -> int:
    """Bucket i holds [EDGES_MS[i-1], EDGES_MS[i])."""
    return bisect_right(EDGES_MS, max(0, int(ms)))


def empty() -> list[int]:
    return [0] * SIZE


def add(h: list[int], ms: int | None) -> None:
    if ms is not None:
        h[slot(ms)] += 1


def merge(hs: Iterable[Sequence[int] | None]) -> list[int]:
    out = empty()
    for h in hs:
        for i, n in enumerate(h or ()):
            if i < SIZE:
                out[i] += int(n)
    return out


def percentile(h: Sequence[int], p: float) -> int | None:
    """Interpolated p-th percentile (0 < p < 1) in ms, or None without samples."""
    total = sum(h)
    if total == 0:
        return None
    target = p * total
    seen = 0
    for i, n in enumerate(h):
        if n and seen + n >= target:
            lo = EDGES_MS[i - 1] if i > 0 else 0
            if i >= len(EDGES_MS):
                return lo  # open bucket: report its lower edge ("≥ 128 s")
            hi = EDGES_MS[i]
            return int(round(lo + (hi - lo) * (target - seen) / n))
        seen += n
    return EDGES_MS[-1]
