# M4b: Jobs page and agent fleet

Branch `m4b`. Built on the M4a backend ([docs/m4a.md](m4a.md), ADRs 0007/0008). Decisions:
[ADR 0009](adr/0009-agent-fleet-overlay.md) (the fleet's data model) and [ADR 0010](adr/0010-level-3-sandbox.md)
(level 3's sandbox, carried over to M7). The plan and your additions were approved on 2026-11-20.

## What you can do now

| Where | What |
|---|---|
| Chat | A reply the router thinks is a job shows **Run as job**. Nothing starts until you confirm. A private chat can't become a job, because agents use cloud models. |
| `/jobs` | **New job**, or start one from chat. Status tabs with counts (Needs you, Running, Queued, Done, Failed, Stopped), agent and project filters (kept in the URL), and **Load more** (keyset paging). |
| `/jobs/<id>` | Approve or reject the plan, the changes or the report, with an optional note. **Stop**, **Run again**, the budget dial with list price, money spent or "cost not reported", the branch with **Copy**, and the `git` commands to review and merge it yourself. Tabs: Timeline (in plain words), Live log (readable, or raw), Plan, Changes (per file), Report. |
| `/jobs/agents` | Every agent: status, installed and logged in, current job, success rate (30 days), today's budget dial, this month's cost, monthly budget, allowed projects, and which levels it can run (with reasons). **Pause / Resume**, **Edit**, **Reset to default** (built-in agents), **Delete** (hired agents), **Hire agent**. |
| Settings → Projects | Add a folder (`~/code/myrepo` works), remove it (with a confirmation), see each project's copies and their disk use, **Clean up now**, and **Keep finished copies** (retention). |
| Settings → Jobs | How long a job may wait for your approval (default 24 h, 0 = never), desktop notifications (this browser, off by default, asked only when you turn them on), and a link to Projects. |
| Sidebar | The Jobs entry shows how many jobs need you. A toast appears when a job needs you, finishes or fails (from any page except that job's own). |
| Status | Paperclip's row always says "No login (local only)" and where Paperclip listens (the loopback check), in Simple mode too. |

## How it works

### Backend (only what the UI needed)

- `GET /jobs` gained `agent` and `project_id` filters. The keyset indexes `(status, id)`, `(agent, id)` and
  `(project_id, id)` come with migration 0008.
- `GET /jobs/counts` returns jobs per status for the tabs and the badge.
- `POST /jobs/preview` returns what a job would do, in plain words, without writing anything. It runs the same agent
  check the job loop uses before the first run (`jobs.agent_check`: paused, allowed project, installed and logged in,
  level available, today's and this month's list-price budget), so the preview can't promise an agent the loop would
  skip. Only "this agent is busy, so the job waits in the queue" is decided later.
- `POST /jobs` takes `agents: [...]` (first choice and fallbacks). Without explicit agents it uses the routing rule's
  chain, as before. Without an autonomy level, it uses the first named agent's default, then the rule's.
- `GET /jobs/proposal?request_id=` returns the chat decision's job proposal for "Run as job".
- `GET /jobs/{id}/runs` lists a job's runs, and `GET /jobs/{id}/log?run=&offset=` pages through any of them. The live
  stream only follows the current run.
- The fleet (ADR 0009):
  - `agent_profiles` is an overlay table on agents.yaml;
  - `POST/PATCH/DELETE /agents/{id}`, `POST /agents/{id}/pause|resume|reset`;
  - `GET /agents` adds the current job, success rate, this month's cost and the templates;
  - Paperclip's name, pause and terminate are kept in sync idempotently.
- `GET/PUT /settings` gained `approval_expiry_h` (default 24) and `keep_worktrees_per_project`. A job that waits longer
  than the expiry is stopped, with the reason "Waited 24 h for your approval of the plan…". Its Paperclip approval is
  rejected, and its copy is removed (the branch stays).
- `GET /projects/{id}/worktrees` reads a project's copies and disk use without changing anything. Before M4b, only
  `cleanup` reported them.
- `/system/components` gives Paperclip structured `notes`: its auth mode and the loopback check (with addresses).
- hostprobe expands a leading `~/` (your home only, never `~other`), and its path errors are plain sentences.

### Portal

- **Server-side only.** Every call goes from the Next.js server to the router with the admin token. Two route
  handlers check loopback Host and same-origin, like the install log:
  - `/api/jobs/[id]/events` proxies the job's SSE and passes on `Last-Event-ID`, so a reconnect resumes at the byte
    offset;
  - `/api/jobs/attention` serves the badge and the toasts.
- **The live log** keeps at most 5,000 lines (older ones are dropped and counted). `lib/log-format.ts` turns the
  JSON events of Claude Code, Codex and OpenCode into the agent's words, commands, tool calls and results. It was
  built from real runs, and its tests use recorded lines. **Show raw output** shows every line.
- **The diff** is split per file in the browser (`lib/diff.ts`, unit-tested). Files can be collapsed, sit on solid
  panels, and are highlighted only when opened (highlight.js in its own chunk). When a job is waiting on its changes,
  the diff comes with the page (server render), so nothing shifts.
- **The autonomy dial** shows level 3 but never lands on it (`Dial` `disabledStops`); the reason is written next to
  it. The router refuses level 3 too (ADR 0010).
- **The job watcher** (a lazy chunk in the sidebar) polls the attention route every 15 s while the page is visible, or
  while desktop notifications are on. Its first answer is only a baseline.
- **Notifications** use the browser's Notification API. Permission is asked when you turn the switch on in Settings,
  never when a page loads.

## The `/chat` Lighthouse fix (dark was 87–93)

Measured on this branch's build (Lighthouse mobile profile, fixture thread with code, 4× CPU throttling):
- **Empty chat:** total blocking time (TBT) 120 ms.
- **The thread:** TBT 360–470 ms. Performance was 88–92 in dark.
- **The thread with the Markdown upgrade switched off:** TBT 150–190 ms.

A CPU profile showed the cause. Every reply was upgraded from plain text to Markdown, and every code block
highlighted, in the same few tasks after load. One React commit took about 150 ms, then Markdown parsing and
highlight.js's language registration added tasks of 60–75 ms.

The fix (`lib/idle-queue.ts`, `chat/Markdown.tsx`, `chat/MarkdownImpl.tsx`):
- Each reply is upgraded on its own, in an idle slice, inside a transition, once it is within 800 px of the screen.
- Code blocks load and highlight in separate idle slices.
- Replies far above stay plain text until you scroll toward them. Chrome's scroll anchoring keeps what you are reading
  still when they grow.

| `/chat` (thread) | before | after (20 runs) |
|---|---|---|
| dark: performance | 88–92 | 95–99 |
| dark: TBT | 360–470 ms | 110–250 ms |
| light: performance | 91–94 (M3b/M4a) | 95–99 |
| CLS | 0.002–0.005 | 0.002 |

The gate (`npm run lighthouse`) now also covers `/jobs`, `/jobs/30`, `/jobs/28`, `/jobs/agents` and
`/settings/projects`, in both themes. Every route scores ≥ 95 for performance and ≥ 99 for accessibility, and 100 for
best practices. Measuring also found two layout shifts, both fixed: the job page's diff (CLS 0.047 → 0) and the
Projects page's copies (0.038 → 0). Both now render with the page.

## Checks

- **Router:** 397 pytest (10 new in `test_m4b.py`, plus updates), ruff and format clean. `pytest -m live` passes against
  Paperclip 2026.1106.0 and now also checks `pause`, `resume` and `terminate` in its OpenAPI document. Found on the
  way: the fake Paperclip stamped every run as started at 06:00 UTC, so the job-time cap fired in `test_turn_cap`
  after 08:00 UTC. It was failing on `main` too; fixed.
- **hostprobe:** 71 unittest (the `~` expansion test is new).
- **Portal:** tsc, eslint, vitest 98 (new: diff parser, log buffer, job formatting, readable log lines).
- **Playwright:** 416 tests, two full runs clean on the final build:
  - `m4b-jobs.spec.ts`, 15 tests: board, detail, the diff, live log and resume, route guards, Run as job, fleet,
    projects, Settings → Jobs, badge, and a toast across pages;
  - axe in both themes on 7 new pages and 3 dialog states;
  - layout checks (360–1920 px and zoom) on 3 more pages;
  - 14 new visual baselines. Changed ones: settings, status, footer, wizard step 5, sidebar rail and drawer.
  - The new captures were stable 280/280 at 14 workers.
- **JS budget** (first load, gzip):
  - `/chat` 180.0 KB, up from 178.8 KB: the sidebar badge store and the idle queue, shared by every route.
  - The new routes: `/jobs` 172.9, `/jobs/[id]` 178.2, `/jobs/agents` 174.1, `/settings/projects` 171.5.
  - The largest is the gallery at 192.4 KB; the cap is 200 KB.
- `test:bundle` passes (the admin token never reaches the browser), and `docs:check` passes.

## Live proof (2026-11-20, real stack, `~/switchboard-playground`)

The router was rebuilt (migration 0008 applied) and hostprobe restarted. A production portal ran on a scratch port,
against your real router, Paperclip and CLIs.

| Step | Result |
|---|---|
| Settings → Projects: remove the playground, then try `~/switchboard`, `~/not-a-folder-xyz`, `/tmp`, `~/switchboard-playground` | Plain refusals: "That is the Switchboard repository itself…", "That folder doesn't exist…", "That folder isn't a git repository…". The last one was added. |
| Chat: "The unit tests in my repo fail after a refactor. Can you fix the failing tests?" | The reply offered **Run as job**. The proposal was Claude Code, then Codex, then OpenCode at level 1. |
| Run as job: OpenCode only, level 1, task "add power(a, b) with a test" | The preview listed the 7 steps. **Job 10** started on confirm. |
| Job 10 | Plan ready in about 4 s → approved with a note → changes ready at 68 s (2 files, +11 −1) → **Approve and commit** at 71 s. Committed `133e35a` on `switchboard/job-10`. A second page showed the toast "Job 10 is done". Your `main` stayed on `6a0e8a4` and clean. |
| New job, OpenCode, dial pressed **End** | The dial stopped at 2 (level 3 off). **Job 11** ran. The readable log showed `→ bash: ls -la`, the agent's words and `→ read: …mathutils.py`. **Stop** cancelled the Paperclip run, left no agent process, removed the copy and kept the branch. |
| Fleet against the real Paperclip | Pause → the Paperclip agent was `paused`; Resume → `idle`; rename → "Switchboard OpenCode (free)"; Reset to default → the name back; hire "Doc writer" (OpenCode template), then delete → soft-deleted (`deleted_at`), gone from the page. |
| Status | `notes`: `local_trusted`, loopback check `127.0.0.1` only. |

Found live and fixed in the same branch:
- The log showed the CLIs' raw JSON events (now readable by default).
- The page stayed on the Live log tab when the plan arrived. A job that starts waiting now opens its Plan or Changes
  tab, unless you picked a tab yourself.

## Decisions taken without asking (reversible)

- **Board layout.** Status tabs with counts rather than kanban columns (your decision 4). The job detail is a page
  (decision 3; SPEC §8c now says so).
- **Badge and toasts poll** a same-origin route every 15 s, instead of keeping one more SSE stream open per tab. A
  toast can arrive up to 15 s after the change.
- **Desktop notifications** are a browser preference (`switchboard.prefs.v1`), not a router setting: permission is
  per browser anyway.
- **Pause** means no new jobs start for that agent. Jobs already started finish, and Stop ends them. Paperclip's pause
  isn't mirrored while the agent has a job in progress, because it would cancel or refuse that job's next run.
- **Paperclip link.** "Open in Paperclip" links to `<PAPERCLIP_UI_URL or http://127.0.0.1:3100>/issues/<id>`. That
  route exists in Paperclip's UI bundle (2026.1106.0). The link was not clicked live.
- **Run again** opens the New job dialog filled with the same task, project, agents and level. Nothing restarts by
  itself.
- **Fixture data.** Jobs are numbered 1–30 so the board has a second page. Paperclip is up in the Status fixture with
  its notes, and Ollama is the service shown down.
- **The demo's jobs segment** uses labelled sample data. A real job on the Demo stack would reuse job numbers, so
  branch names and Paperclip issue keys would collide with your real jobs (see docs/recording-the-demo.md).

## Not done here (carried over)

- **Level 3** (ADR 0010): the container sandbox, egress proxy, login volume and live negative tests, in M7.
- **Optional agents** (Gemini CLI, Grok Build, Hermes): still not verified for jobs, so they can't be hired.
- **Paperclip-native mode** (ADR 0007 "Later").
- **Process note:** a Claude Code safety check refused one heredoc that wrote a test file (it contained no removal).
  The same file was written with the file tools.
