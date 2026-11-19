# 0001. Record architecture decisions

Status: accepted (2026-11-19)

## Context
Switchboard is built one milestone at a time, often in fresh sessions. Reasons behind a choice live in chat
history and are lost; later work then either re-litigates or silently contradicts them.

## Options
1. Keep decisions only in docs/PROGRESS.md "Key decisions": short, but no room for options or consequences.
2. One short ADR per significant decision in `docs/adr/` (Michael Nygard format).
3. A wiki or issue tracker: outside the repo, so it drifts and is not versioned with the code.

## Decision
Option 2. Each significant decision (architecture, data model, dependency, security, UX pattern) gets
`docs/adr/NNNN-title.md` with Context, Options, Decision, Consequences. PROGRESS.md links to it. An ADR is never
edited to change history: a later ADR supersedes it and says so.

## Consequences
- Small writing cost per decision; reasoning survives across sessions and contributors.
- Reviews can check a change against the recorded decision.
- PROGRESS.md stays a status log and links here for the "why".
