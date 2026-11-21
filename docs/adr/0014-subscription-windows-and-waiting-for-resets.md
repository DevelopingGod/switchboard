# 0014. Subscription windows: reported first, estimated honestly; jobs wait for resets

Status: accepted (2026-11-21, M6.5)

## Context
Claude Pro and ChatGPT plans limit use in rolling windows (Claude: 5-hour and 7-day; Codex: a window per
plan, 30 days on the free plan seen here). Before M6.5 Switchboard could not see them: the API quota guard
(M3a) covers API-key models only, and a job that hit a limit simply failed. The owner wants to see each
window ("Claude Pro: ~70% of this window, resets 14:20"), steer lighter work elsewhere before the limit, and
have a job that hits the limit pause and continue after the reset.

What the CLIs actually report was checked on this machine (2026-11-21):
- **Claude Code 2.1.326** prints `rate_limit_event` lines in its stream-json output, with each window's
  `utilization`, `resetsAt` and `status` (`allowed` / `rejected`). Seen in five real job logs. No separate
  usage command; `claude auth status --json` gives the plan (`subscriptionType`).
- **Codex 0.170.0**: `codex exec --json` prints tokens only. Its own session file
  (`$CODEX_HOME/sessions/…/rollout-…-<thread id>.jsonl`) has `rate_limits` with `used_percent`,
  `window_minutes` and `resets_at`. The run's `thread.started` event gives the thread id.
- A real limit hit (`rejected`) was not captured live (it needs a used-up window); its shape is the same
  event with that status, and run errors are matched against `limit_patterns` as a second check.

## Options
1. **Estimate only** from Switchboard's own runs. Never wrong about where the numbers came from, but blind to
   use outside Switchboard and to the real reset time.
2. **Reported first, estimate as fallback**, always labelled. Claude: read live from the run's own output.
   Codex: hostprobe reads only the numbers from that run's session file.
3. **Scrape the vendors' web usage pages.** Rejected: against SPEC §2 (no browser scraping) and fragile.

For a job that hits a limit: (a) fail it (before); (b) wait and re-run the interrupted phase in the same
worktree; (c) resume the CLI's own session (`claude --resume`, `codex exec resume`): keeps context, but is
different per CLI and needs its own verification.

## Decision
Option 2 and (b), with your conditions:
- `usage_windows` keeps the latest reading per (CLI, account, window): one row each, so it never grows.
  Claude's reading is stored while the run streams; Codex's after each run, through hostprobe
  `POST /codex/usage {thread_id}`: a UUID only (no paths), only that file, no symlinks anywhere on the way,
  the last 4 MB only, and only numbers come back (plus a "limit reached" boolean). If the file is missing or
  unparseable, the window is an estimate.
- An **estimate** is our own consumption in the window (list price for Claude, tokens for Codex) divided by a
  capacity learned from the last report. Without a calibration there is no percentage, only "N runs in the
  last 5 hours". Every estimate is labelled; the UI puts "~" before an estimated share.
- **Guard** (`agents.yaml` `subscription_guard`): at 80% of a window, light jobs (level 0, or a Run-as-job
  whose rule isn't `code-heavy`) go to the next agent in the chain; at 100% (or `rejected`) every job does.
  The job preview, Run as job and the engine use the same check.
- **Waiting**: a run that ends on a limit sets the job to `waiting_reset` until the reported reset (else the
  configured window, marked as an estimate). The worktree stays; after the reset the same phase runs again
  with a note to check `git status`/`git diff` first. The wake's idempotency key gets an attempt suffix. A
  job whose agents are all window-blocked before it starts waits too, instead of failing. Everything is in
  the database, so a restart loses nothing.
- **A far reset asks first**: if the reset is more than `max_auto_wait_h` (12 h) away, the job goes to
  "Needs you" (gate `limit`): Wait anyway, Run on another agent (another provider only, ADR 0013), Use paid
  overflow (ADR 0015) or Cancel. Approval expiry applies, so nothing starts days later by itself.
- After `max_waits` (3) waits the job fails with a plain reason.
- Shown on Agents (a meter per account), Status (one row per account used), Metrics Pro (windows and limit
  hits in 30 days) and the New job preview.

## Consequences
- Windows are only as fresh as the last run through Switchboard; use of the CLI outside Switchboard shows
  up only in Claude's and Codex's own reports.
- The Codex session-file read is the one read-only exception near a CLI home (numbers only, tested for
  traversal, symlinks and content leakage).
- Re-running a phase repeats some work the interrupted run did; resuming the CLI's own session is a later
  optimisation (PROGRESS carry-over).
- `ROUTER_LIMIT_TEST=claude:resets_in=N` (dev only, doctor warns) makes the next run of that CLI in a job
  end as a limit hit, to show waiting and resuming without using up a real window.
