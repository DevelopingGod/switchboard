"""What one agent run produced, read from Paperclip (M4a; formats verified in docs/m4a.md).

- Claude (`claude_local`): Paperclip parses the CLI itself: `resultJson.summary`/`result`, `num_turns`,
  `permission_denials`, and `usageJson` with `costUsd` and `billingType` (`subscription_included` = $0 to
  you).
- Codex (`process` runner, `codex exec --json`): JSONL on stdout: `item.completed` items (agent messages,
  commands), `turn.completed.usage` (tokens; Codex reports no cost).
- OpenCode (`process` runner, `opencode run --format json`): JSONL: `text` parts, `tool_use` parts and
  `step_finish` parts with `tokens` and `cost`.

`TurnCounter` follows a run's output while it runs (for the turn and list-price caps); `outcome()` reads the
finished run. Budgets use list price; `cost_usd` is money actually spent (ADR 0007, your rule).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.agents import AgentDef

SUBSCRIPTION_BILLING = {"subscription_included", "subscription"}
VENDOR = {"claude": "anthropic", "codex": "openai", "opencode": "opencode"}


@dataclass
class TurnCounter:
    """Counts model turns and list price from a run's stdout as it streams. Keeps only the unfinished last
    line."""

    permissions: str
    turns: int = 0
    list_price_usd: float = 0.0
    _tail: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)  # the parsed JSON lines (for outcome())

    def feed(self, chunk: str) -> None:
        text = self._tail + chunk
        *lines, self._tail = text.split("\n")
        for line in lines:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict):
                continue
            self.events.append(ev)
            t = ev.get("type")
            if self.permissions == "claude" and t == "assistant":
                self.turns += 1
            elif self.permissions == "codex" and t == "item.completed":
                self.turns += 1
            elif self.permissions == "opencode" and t == "step_finish":
                self.turns += 1
                part = ev.get("part") or {}
                if isinstance(part.get("cost"), int | float):
                    self.list_price_usd += float(part["cost"])

    def finish(self) -> None:
        if self._tail.strip():
            self.feed("\n")


@dataclass(frozen=True)
class RunOutcome:
    text: str
    turns: int
    tokens_in: int | None
    tokens_out: int | None
    list_price_usd: float | None  # None = the CLI reports no cost ("cost not reported")
    cost_usd: float  # money actually spent: $0 on a subscription or a free model
    provider: str | None
    model: str | None
    denied: tuple[str, ...] = ()  # commands the agent wanted but wasn't allowed (Claude reports them)


def _codex(events: list[dict[str, Any]]) -> tuple[str, int | None, int | None]:
    text, tin, tout = "", None, None
    for ev in events:
        item = ev.get("item") or {}
        if ev.get("type") == "item.completed" and item.get("type") == "agent_message":
            text = str(item.get("text") or text)
        if ev.get("type") == "turn.completed":
            u = ev.get("usage") or {}
            tin = (tin or 0) + int(u.get("input_tokens") or 0)
            tout = (tout or 0) + int(u.get("output_tokens") or 0)
    return text, tin, tout


def _opencode(events: list[dict[str, Any]]) -> tuple[str, int | None, int | None, float]:
    texts: list[str] = []
    tin = tout = 0
    cost = 0.0
    for ev in events:
        part = ev.get("part") or {}
        if ev.get("type") == "text" and part.get("text"):
            texts.append(str(part["text"]))
        if ev.get("type") == "step_finish":
            tok = part.get("tokens") or {}
            tin += int(tok.get("input") or 0)
            tout += int(tok.get("output") or 0)
            if isinstance(part.get("cost"), int | float):
                cost += float(part["cost"])
    return (texts[-1] if texts else ""), tin, tout, cost


def outcome(agent: AgentDef, run: dict[str, Any], counter: TurnCounter | None = None) -> RunOutcome:
    """The finished run's message, usage and cost. `counter` holds the stdout events read from the run log
    (process runners); without it, `resultJson.stdout` is used."""
    rj = run.get("resultJson") or {}
    usage = run.get("usageJson") or {}
    vendor = VENDOR.get(agent.permissions or "", None)
    if agent.runner == "claude_local":
        listed = usage.get("costUsd")
        listed = float(listed) if isinstance(listed, int | float) else None
        billing = str(usage.get("billingType") or "")
        denied = tuple(
            str((d.get("tool_input") or {}).get("command") or d.get("tool_name") or "")
            for d in rj.get("permission_denials") or []
            if isinstance(d, dict)
        )
        return RunOutcome(
            text=str(rj.get("summary") or rj.get("result") or run.get("lastAssistantSnippet") or ""),
            turns=int(rj.get("num_turns") or (counter.turns if counter else 0)),
            tokens_in=usage.get("inputTokens"),
            tokens_out=usage.get("outputTokens"),
            list_price_usd=listed,
            cost_usd=0.0 if (listed is None or billing in SUBSCRIPTION_BILLING) else listed,
            provider=usage.get("provider") or vendor,
            model=usage.get("model") or agent.model,
            denied=denied,
        )
    if counter is None:
        counter = TurnCounter(agent.permissions or "")
        counter.feed(str(rj.get("stdout") or ""))
        counter.finish()
    if agent.permissions == "codex":
        text, tin, tout = _codex(counter.events)
        return RunOutcome(text, counter.turns, tin, tout, None, 0.0, vendor, agent.model)
    text, tin, tout, cost = _opencode(counter.events)
    # OpenCode reports a cost per step; for its free Zen models that is $0. A paid model's cost is real money.
    return RunOutcome(text, counter.turns, tin, tout, cost, cost, vendor, agent.model)
