# 0007. Jobs: Switchboard drives the phases, Paperclip runs the agents

Status: accepted (2026-11-20)

## Context
M4 turns job-like requests (repo work, multi-step research) into agent jobs. SPEC §2 says reuse Paperclip for agents,
tasks, approvals, budgets and run history rather than rebuild them. Verifying Paperclip 2026.1106.0's real behaviour
(docs/m4a.md) showed that its issue-scoped runs expect the agent to manage the issue: when a run ends without a
comment or a final status, Paperclip starts up to three more runs on its own (each a full CLI run on your
subscription). A read-only planning run can't set an issue's status, and reassigning or re-statusing the issue during
a run cancels or is overwritten. Its git-worktree isolation is an experimental, default-off flag that silently falls
back to the user's own checkout. Two of its local adapters touch CLI login files or the user's Claude skills folder.

## Options
1. **Paperclip-native.** Agents follow Paperclip's protocol (comment, set status, write a `plan` document, request
   plan approval) through its API. Uses Paperclip as designed, but every CLI must comply; read-only planning needs
   network access to Paperclip's API; a non-compliant run costs extra automatic runs.
2. **Switchboard drives the phases; Paperclip runs the agents.** Each job still has a Paperclip issue and its plan and
   diff approvals are real Paperclip approvals linked to it, but runs are agent-level wakes (no issue scope), so
   Paperclip never re-wakes anyone. Switchboard owns the state machine.
3. Run the CLIs from Switchboard without Paperclip. Rejected: rebuilds the run engine, logs, cancel and cost records.

## Decision
Option 2 (your choice, 2026-11-20), keeping the adapter shape open for option 1 later (a lead agent delegating to
others needs Paperclip's own issue protocol; see "Later").
- **One Paperclip company** "Switchboard", created on first use; its id is kept in `system_meta` (`paperclip`).
- **One Paperclip agent per registry entry** (`config/agents.yaml`), created and kept in sync by the router, never
  deleting agents it didn't create. Max one active job per agent (configurable), so the router may set an agent's
  config just before each run: working folder (the job's worktree), the autonomy level's flags, a clean environment,
  and the task (Claude: the agent's `AGENTS.md`; process runners: the command's last argument).
- **Runners.** Claude Code uses Paperclip's `claude_local` adapter (`engine: cli`), which uses `~/.claude` in place.
  Codex and OpenCode use Paperclip's plain `process` adapter with a fixed Switchboard command line, because their
  Paperclip adapters copy login files or write skills into `~/.claude` (docs/m4a.md). Rule for all agents:
  **Switchboard and Paperclip never copy, read, move or write CLI login files.**
- **Runs** are `POST /agents/:id/wakeup` with `forceFreshSession` and an idempotency key per job phase; the router
  polls the run, reads output from the run log (byte offsets, resumable) and stops with `POST …/cancel`.
- **The job's Paperclip issue** is assigned to the board user, never to an agent, and its status mirrors the job
  (todo, in_progress, in_review, done, cancelled, blocked); each run's summary is posted as a comment.
- **Approvals** (plan, diff, result) are `request_board_approval` approvals linked to the issue. Approve and reject
  in Switchboard call Paperclip's approve/reject; one decided in Paperclip's UI is picked up by the job loop.
- **Costs** come from each run (`usageJson` for Claude; the CLI's JSON events for the process runners) and are written
  to `costs` with `source = paperclip`, keyed by run id so re-ingesting is a no-op.
- **Auth.** Paperclip stays in `local_trusted` mode (no login on loopback). The risk: any local process can call its
  admin API, including starting agents on your subscriptions. Status shows "Paperclip has no login (local only)", and
  doctor and Status check that Paperclip listens on 127.0.0.1 only (red if on 0.0.0.0 or a LAN address). The adapter
  already sends a bearer key when `PAPERCLIP_API_KEY` is set. Revisit with portal auth in M7.
- **Version pin.** `PAPERCLIP_VERSION=2026.1106.0`; the router compares `/api/health` and shows a mismatch in Status.
  Contract tests replay recorded responses; a live variant (`PAPERCLIP_LIVE=1`) re-checks the running instance.

## Consequences
- No automatic extra runs: jobs spend only the runs Switchboard starts (verified).
- Paperclip's UI still shows every job (issue, comments, approvals, runs, costs), and its budget and run history
  remain the source of record for agent runs.
- The router depends on more Paperclip endpoints (listed in docs/m4a.md); the contract tests are the tripwire for
  an upgrade.
- One active job per agent is a hard assumption of the per-run config: raising `max_active_per_agent` above 1 needs
  one Paperclip agent per slot (the registry can create `claude-code#2`), which the code allows but M4a doesn't test.
- Paperclip needs the CLI folders on its service PATH (systemd drop-in; setup and doctor).

## Later (not built)
- **Paperclip-native mode** for fleets: a lead agent delegating child issues needs issue-scoped runs and Paperclip's
  own plan/approval protocol. The adapter keeps issue, approval and wake calls separate so a `mode: native` job type
  can use them; it would need the Paperclip API reachable from inside each agent's sandbox.
- Authenticated mode with a board key (M7, with portal auth).
