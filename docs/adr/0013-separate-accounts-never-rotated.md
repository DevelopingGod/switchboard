# 0013. Separate accounts for separate purposes; never rotated around limits

Status: accepted (2026-11-21, M6.5)

## Context
Subscription CLIs (Claude Code, Codex) have one login per CLI home. An owner may legitimately have more than
one: a personal Claude Pro and a company Team seat, kept apart so work for the company runs on the company's
seat and personal work on the personal plan. M6.5 also adds usage-window awareness, and a tempting misuse
follows from it: when one account's window is used up, switch to another account of the same provider and
carry on. Providers' terms forbid sharing or rotating accounts to get around usage limits (Anthropic and
OpenAI both treat it as abuse), and it can get every account involved banned. Switchboard is open source, so
whatever it makes easy, many people will do.

The M4a rule still holds: Switchboard and Paperclip never copy, read, move or write a CLI's login files.

## Options
1. **One login per CLI** (as before). Simple, but personal and company work share one plan.
2. **Named accounts, each a separate CLI home the vendor CLI logs into itself**, chosen by you per project
   or per agent, and never switched automatically.
3. **Named accounts with automatic rotation** when a window is used up. Rejected: against the providers'
   terms, a ban risk for the user, and the kind of feature Switchboard must not make easy.

## Decision
Option 2.
- An extra account is a folder `~/.switchboard/accounts/<cli>/<name>` (mode 700) that hostprobe creates
  empty; from then on only the vendor CLI writes in it (even `claude auth status` creates `.claude.json`). You log in with the vendor's own command, which Switchboard shows for you to copy:
  `CLAUDE_CONFIG_DIR=<folder> claude auth login` or `CODEX_HOME=<folder> codex login`. "default" is the
  CLI's normal home. The variable per CLI is configuration (`config/agents.yaml` → `clis.<id>.home_env`).
- Switchboard never reads, copies or moves anything inside these folders. A job run only sets the CLI's
  own config-folder variable, so the vendor CLI uses that login in place. hostprobe runs the same fixed
  status command with that variable to say whether the account is logged in and which plan it is (the plan
  label only; never the email, org or ids).
- You choose the account per project (wins) or per agent (Agents → Edit).
- **A job is bound to one account per CLI when it is created.** A fallback chain that would use two
  accounts of one CLI is refused at create and in the preview; the job engine skips such an agent; "Run on
  another agent" for a job waiting on a limit only offers other providers. Each is tested.
- When an account's window is used up, a job falls back to another provider, waits for the reset, or uses
  paid overflow if you opted in (ADRs 0014 and 0015). The README FAQ says so.

## Consequences
- Personal and company work can be kept apart without Switchboard touching any login.
- Removing an account in Switchboard leaves its folder and login on disk (Switchboard never deletes inside
  it); the UI says how to log out or delete it.
- The one read-only exception near a CLI home is Codex's usage numbers (ADR 0014): hostprobe reads only
  numbers from that run's own session file, never a login file.
- A future multi-user portal must keep accounts per user; out of scope until portal login (M7).
