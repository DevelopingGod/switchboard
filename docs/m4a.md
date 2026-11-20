# M4a: Agents & Jobs backend

Branch `m4a`. Decisions: [ADR 0006](adr/0006-local-thinking-profile-setting.md) (local chat without a thinking phase),
[ADR 0007](adr/0007-paperclip-integration-shape.md) (how jobs use Paperclip), [ADR 0008](adr/0008-hostprobe-git-worktrees.md)
(worktrees through hostprobe). M4b builds the UI on this.

## Paperclip 2026.1106.0: the API as verified (2026-11-20)

Verified against the running instance (`~/.paperclip/cli/current`, systemd user unit `paperclipai.service`), its
source in `@paperclipai/server/dist` and `GET /api/openapi.json` (OpenAPI 3.0, generated at runtime, 818 paths), with a
throwaway company and a `process` agent first (no subscription quota), then one small real run per CLI. Raw request
and response pairs are the contract-test fixtures in `services/router/tests/fixtures/paperclip/`.

### Auth
- The instance runs `deploymentMode: local_trusted`, `deploymentExposure: private` (`GET /api/health`). Every request
  without an `Authorization` header is the implicit instance admin "board" user `local-board`; the CSRF guard does not
  apply to it. Paperclip refuses to start `local_trusted` on a non-loopback host.
- `authenticated` mode works on loopback too, but needs a Paperclip user account (Better Auth) and board API keys
  (`pcp_board_…`) that expire after 30 days and are issued through a human-approved CLI challenge. Kept
  `local_trusted` for M4a (your decision; ADR 0007); the adapter sends `Authorization: Bearer` when
  `PAPERCLIP_API_KEY` is set, so switching later is configuration.

### Endpoints Switchboard uses

| Purpose | Call | Notes |
|---|---|---|
| Health, version | `GET /api/health` | `version`, `deploymentMode`, `deploymentExposure` |
| Company | `GET /api/companies`, `POST /api/companies {name, description}` | one "Switchboard" company; id kept in `system_meta` |
| Agent | `POST /api/companies/:c/agents`, `GET/PATCH /api/agents/:id` | see "Agents" below |
| Agent check | `POST /api/companies/:c/adapters/:type/test-environment {adapterConfig}`, `POST /api/agents/:id/lifecycle/retry` | a new agent is `paused`/`verifying` until its check passes, then `idle`/`ready` |
| Task text | `PUT /api/agents/:id/instructions-bundle/file {path:"AGENTS.md", content}` | `promptTemplate` is refused for new agents (422) |
| Start a run | `POST /api/agents/:id/wakeup {source:"on_demand", reason, forceFreshSession, idempotencyKey}` | 202 with the run (`status: queued`); same key again → `{status:"skipped"}` |
| Run status | `GET /api/heartbeat-runs/:id` | `status` queued/running/succeeded/failed/cancelled/timed_out, `resultJson`, `usageJson`, `error`, `errorCode` |
| Run output | `GET /api/heartbeat-runs/:id/log?offset=&limitBytes=` | `{content}` = NDJSON lines `{ts, stream, chunk}`; byte offsets, so it resumes |
| Run events | `GET /api/heartbeat-runs/:id/events?afterSeq=&limit=` | Paperclip's own lifecycle events (`seq`) |
| Stop | `POST /api/heartbeat-runs/:id/cancel` | run → `cancelled`; unknown run → 404 (treated as done) |
| Job record | `POST /api/companies/:c/issues {title, description, status, assigneeUserId, idempotencyKey}`, `PATCH /api/issues/:id`, `POST /api/issues/:id/comments {body}` | same `idempotencyKey` → the same issue (200) |
| Approvals | `POST /api/companies/:c/approvals {type:"request_board_approval", payload, issueIds}`, `POST /api/approvals/:id/approve\|reject {decisionNote}`, `GET /api/issues/:id/approvals` | approving twice → 200 (idempotent) |
| Costs | `usageJson` on each run; `GET /api/issues/:id/cost-summary`, `GET /api/companies/:c/costs/*` | see "Costs" |

There is no SSE for run output: the log endpoint is polled (a WebSocket exists at
`/api/companies/:c/events/ws`; polling is enough and resumes by offset).

### Issue-scoped runs re-wake the agent on their own (why jobs don't use them)
Assigning an issue to an agent starts a run (`invocationSource: assignment`). When that run ends, Paperclip may start
more runs without being asked, each one a full CLI run:
- `missing_issue_comment`: the run didn't comment on the issue → one retry.
- `issue_disposition_repair`: the issue is still `todo`/`in_progress` → up to 2 more runs.
- `issue_review_path_lost`: the issue was moved to `in_review` with no reviewer → another run.
Agents avoid this by following Paperclip's skill (they comment and set the status through Paperclip's API). A
read-only planning run can't. Unassigning or reassigning the issue cancels a queued or running run, and patching
the status during a run is overwritten when it ends. `executionPolicy.commentRequired: false` is dropped on create.
**Agent-level wakes** (`POST /agents/:id/wakeup` with no issue, `scopeKind: company`) trigger none of this (verified):
that is what jobs use (ADR 0007). The job's issue is assigned to the board user, never to an agent (`in_progress`
requires an assignee).

### Worktrees
Paperclip can give each issue a git worktree (`executionWorkspacePolicy` with `workspaceStrategy.type: git_worktree`),
but only behind the experimental instance flag `enableIsolatedWorkspaces` (off), and with the flag off it **silently
drops** the request and runs in the project's own checkout (verified: the run's execution workspace was
`shared_workspace` / `project_primary` on the user's directory). It also defaults to worktrees inside the repo
(`.paperclip/worktrees`) and only works for issue-scoped runs. Switchboard creates worktrees itself through hostprobe
(ADR 0008).

### Agents and adapters
- A run's environment is the Paperclip service's own environment plus `PAPERCLIP_*` variables (the run's JWT,
  API URL, ids) and the agent's `env`. The service has no Switchboard or provider secrets (checked by name only),
  but does have `SSH_AUTH_SOCK` (the user's SSH agent), `DBUS_SESSION_BUS_ADDRESS` (the desktop keyring) and gets
  `GH_CONFIG_DIR` / `PAPERCLIP_GITHUB_*` (the GitHub CLI's login). Every Switchboard agent overrides these.
- Paperclip redacts some env values when an agent is read (it treats `SSH_AUTH_SOCK` as sensitive) and refuses the
  redacted placeholder back (422 "Refusing to persist redacted placeholder"): the router always sends its own complete
  config, never a read-modify-write.
- The service's `PATH` did not include `~/.local/bin` or `~/.opencode/bin`, so a new Claude agent stayed `paused`
  ("The execution command was not found"); its hello probe deliberately uses only the server's own PATH. Fixed with a
  systemd drop-in that adds the CLI folders (`~/.config/systemd/user/paperclipai.service.d/switchboard-path.conf`,
  written by `scripts/setup-wsl.sh`, checked by doctor).

**Login files (your rule: Switchboard and Paperclip never copy, read, move or write CLI login files):**

| Adapter | What it does with the CLI's home (verified in source and on disk) | Switchboard uses |
|---|---|---|
| `claude_local` | Local runs use your `~/.claude` in place. Skills go to Paperclip's own prompt cache and are passed with `--add-dir`. Login files are copied only for *remote* execution targets, which Switchboard never uses. | `claude_local`, `engine: cli` |
| `codex_local` | Builds a managed Codex home per company and **copies `~/.codex/auth.json` into it** (seen: two copies under the probe company at 06:18), copies refreshed tokens back, injects skills into whatever `CODEX_HOME` it runs with. | `process` runner: `codex exec --json …` |
| `opencode_local` | **Symlinks Paperclip's skills into `$HOME/.claude/skills`** (seen: `paperclip`, `complain`, `suggestion-box` appeared in your own Claude Code). | `process` runner: `opencode run --format json …` |

The three skill links and the two copied Codex login files were created by these probes and removed afterwards. The
feedback skills post only to the local Paperclip (`/api/companies/:c/agent-commentary`).

### Costs as reported
| CLI | Run `usageJson` / output | Switchboard records |
|---|---|---|
| Claude (`claude_local`) | `costUsd` (e.g. 0.0627), `costStatus: reported`, `billingType: subscription_included`, tokens | `cost_usd` 0, `list_price_usd` = `costUsd` |
| Codex (`process`) | JSONL `turn.completed.usage` (tokens only; no cost anywhere) | tokens, `cost_reported: false` ("cost not reported") |
| OpenCode (`process`) | JSONL `step_finish.part.cost` and tokens (0 for free Zen models) | summed per run |

## CLI flags per autonomy level (verified on this machine)

Versions: Claude Code 2.1.326, Codex CLI 0.170.0, OpenCode 1.19.6. `gemini` is a Windows binary only; `grok` and
`hermes` are not installed (shown as "not installed"). Each row was run for real with a negative test: the task
asked the agent to `touch` a file (level 0), or to `git push` and `curl` the internet (level 2).

| Level | Claude Code | Codex | OpenCode | Result |
|---|---|---|---|---|
| 0 read-only | `--permission-mode plan` | `exec --json -s read-only` | permission `{edit: deny, bash: deny, webfetch: deny}` | plan returned; `touch` refused (Codex: read-only sandbox; OpenCode: no shell tool); repo untouched |
| 1 plan, approve, edit | level 0 run, approval, then the level 2 run | same | same | live proof jobs 2–4 below: plan, approval, edits in the worktree, diff, commit |
| 2 edits + allowlisted commands | `--permission-mode acceptEdits --setting-sources user --allowedTools Bash(<cmd>:*) --disallowedTools WebFetch WebSearch Bash(git push:*) Bash(curl:*)` | `exec --json -s workspace-write -c sandbox_workspace_write.network_access=false -C <worktree>` | permission `{edit: allow, bash: {"*": deny, "<cmd>*": allow}, webfetch: deny}`, `OPENCODE_DISABLE_PROJECT_CONFIG=true` | edits only in the worktree; tests ran; push and curl refused (Claude: permission layer; Codex: no network in the sandbox; OpenCode: permission rule) |
| 3 full auto | **off**: Paperclip's bwrap sandbox (`filesystemScope: workspace`) fails to start here (job 9 below) | off (needs a verified bwrap wrapper) | off (same) | never runs unsandboxed: the job fails with the reason before anything runs |

Notes:
- Claude's `default` permission mode is gone in 2.1.326 (`manual`/`auto`/`dontAsk` are new); headless `-p` denies any
  tool not allowed, which is what levels 1–2 rely on. `--setting-sources user` stops a repo's `.claude/settings.json`
  from pre-approving commands. Paperclip's `claude_local` defaults `dangerouslySkipPermissions: true`; Switchboard
  always sets it.
- Codex: `-s` overrides the adapter-style `-c sandbox_mode=…`; `exec` has no `--full-auto` or `-a` in 0.170.0.
  Codex loads a repo's own `.codex/config.toml` only for projects you trusted, and a fresh worktree isn't.
- OpenCode reads permissions from `OPENCODE_CONFIG_CONTENT`; `OPENCODE_DISABLE_PROJECT_CONFIG=true` stops a repo's
  `opencode.json` from widening them.
- `PYTHONDONTWRITEBYTECODE=1` keeps test runs from leaving `__pycache__` in the diff.

## Using jobs (API; the page comes in M4b)

All calls need the router's admin token (`Authorization: Bearer $ROUTER_ADMIN_TOKEN`); the portal will add them.

```bash
# 1. allow a folder (the top of a git repo with at least one commit; never the Switchboard repo)
curl -sX POST localhost:8100/projects -H "$AUTH" -H 'Content-Type: application/json' -d '{"path":"/home/you/myrepo"}'
# 2. start a job (agent from the routing rule, or name one; autonomy 0-3; budget is list price in USD)
curl -sX POST localhost:8100/jobs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"prompt":"Add a function multiply(a, b) with tests","project_id":1,"agent":"claude-code","autonomy":1}'
# 3. follow it (SSE), read the plan or diff, decide
curl -N localhost:8100/jobs/1/events -H "$AUTH"
curl -s localhost:8100/jobs/1/diff -H "$AUTH"
curl -sX POST localhost:8100/jobs/1/approve -H "$AUTH" -H 'Content-Type: application/json' -d '{"note":"ok"}'
```

`GET /agents` shows which agents can run which levels now and why not. Approvals also appear in Paperclip's own UI
(the Switchboard company), and deciding there works too.

## Live proof (2026-11-20, `~/switchboard-playground`)

A tiny git repo (`mathutils.add` + one unittest test). Each job: "Add a function `<name>(a, b)` … and a unittest test
… then run the tests", autonomy 1, through the router API exactly as above.

| Job | Agent | Level | Outcome | Time | Runs | List price | Spent | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Claude Code | 1 | failed | 3 s | 0 | – | $0 | Paperclip refused the instructions write (revision guard): fixed, see below |
| 2 | Claude Code | 1 | done | 28 s | 2 | $0.134 | $0 | plan → approved → `multiply` + test, 2 tests pass, committed `90cc7b4` on `switchboard/job-2` |
| 3 | Codex | 1 | done | 46 s | 2 | not reported | $0 | `subtract`, committed `80dae72` on `switchboard/job-3` |
| 4 | OpenCode | 1 | done | 62 s | 2 | $0 | $0 | `divide`, committed `a98dc00` on `switchboard/job-4` |
| 5 | OpenCode | 1 | stopped | 13 s | 1 | $0 | $0 | plan rejected with a note; worktree removed |
| 6 | OpenCode | 1 | stopped | 4 s | 0 | – | $0 | stopped while running: Paperclip run cancelled, no process left, worktree removed |
| 7 | Claude Code | 1 | stopped at budget | 8 s | 1 | $0.054 | $0 | budget $0.03: Claude stopped itself at `--max-budget-usd`; recorded |
| 8 | Claude Code | 0 | done | 10 s | 1 | $0.057 | $0 | after job 7 left the agent in `error`: cleared, report reviewed, worktree removed |
| 9 | Claude Code | 3 | failed | 3 s | 0 | $0 | $0 | Paperclip's bwrap sandbox didn't start: `Can't bind mount /oldroot/usr/bin on /newroot/bin` (Ubuntu 24.04 has `/bin` → `/usr/bin`). Nothing ran unsandboxed; level 3 is now off for every agent (config, with this reason) |

Your `main` stayed on `6a0e8a4` and clean throughout; every job branch is kept. `costs` got one row per run (9),
all `source = paperclip`, keyed `paperclip-run:<id>`, $0 real money, $0.24 list price; none counted toward the chat
daily cap. Refusals checked live: the Switchboard repo (403), a folder that isn't a repo (400), a job outside the
allowlist (400). An agent run's environment (151 variable names, values never printed): no Switchboard, router,
LiteLLM, hostprobe, database or provider-key variables; `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `GH_TOKEN` empty;
`git push` failed locally (`remote-switchboard-no-push`).

The live proof found five bugs the fakes didn't model, each fixed with a test and the fakes made stricter:
instruction writes need the revision Paperclip last served; an agent left in `error` must be cleared; Claude's own
budget stop is a stop, not a failure; a stopped run's usage must still be recorded; a failed job's worktree can come
back as an empty folder (Paperclip recreates a missing working folder when checking an agent).

## More Paperclip behaviour found on the way

- Deleting a company removes it from the API but leaves `~/.paperclip/instances/default/companies/<id>/` on disk,
  including a `codex-home` with the copied login if `codex_local` was ever used. (Switchboard never uses it; the probe
  company's folder was deleted by hand.)
- A terminated agent can't be deleted (`DELETE /agents/:id` answers 500); it stays terminated and hidden.
- `executionPolicy.commentRequired: false` is dropped on create, and `executionWorkspacePreference` is dropped while
  `enableIsolatedWorkspaces` is off: Paperclip ignores unsupported fields silently, so the contract tests check the
  fields Switchboard relies on in the responses, not just the status codes.
