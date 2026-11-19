"""One low-priority queue for local background generations (M3b, ADR 0002).

Thread titles and long-thread summaries run on the local tasks model, and on the `small` profile that
model shares CPU cores with the classifier (both are pinned to the CPU so nothing evicts the chat
model from a 4 GB GPU). Two rules keep them from hurting each other:

- background jobs run **one at a time**, in the order they arrived;
- a job **does not start while a classification is in flight**: the classifier decides whether a
  message may leave the machine, so it always goes first. A job that is already running can't be
  interrupted; its cost to the classifier is measured in docs/m3a.md.

The queue is bounded (`MAX_WAITING`): when it is full the caller gets `QueueFull` and falls back
(titles use the first words), so memory never grows with traffic. State is two counters, no
event-loop-bound primitives, so it works across loops (tests) and needs no persistence: every job is
re-creatable from the thread.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

MAX_WAITING = 16
POLL_S = 0.05


class QueueFull(RuntimeError):
    pass


class _State:
    def __init__(self) -> None:
        self.classifying = 0
        self.running = False
        self.order: list[object] = []  # waiting jobs, first in line first


_s = _State()


def reset() -> None:
    global _s
    _s = _State()


def stats() -> dict[str, int]:
    return {"classifying": _s.classifying, "running": int(_s.running), "waiting": len(_s.order)}


@asynccontextmanager
async def classifying() -> AsyncIterator[None]:
    """Wrap a classifier call: background jobs wait while any of these is open."""
    state = _s
    state.classifying += 1
    try:
        yield
    finally:
        state.classifying -= 1


@asynccontextmanager
async def background() -> AsyncIterator[None]:
    """Wrap a background generation. Raises `QueueFull` at once when too many are waiting. A job that
    is cancelled while waiting (its timeout) leaves the line without blocking the others."""
    state = _s  # a reset() mid-wait must not corrupt the new state
    if len(state.order) >= MAX_WAITING:
        raise QueueFull(f"{MAX_WAITING} local background jobs are already waiting")
    me = object()
    state.order.append(me)
    try:
        # Polling on purpose: no loop-bound Event (see the module docstring).
        while state.order[0] is not me or state.running or state.classifying:  # noqa: ASYNC110
            await asyncio.sleep(POLL_S)
        state.running = True
    finally:
        state.order.remove(me)
    try:
        yield
    finally:
        state.running = False
