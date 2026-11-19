# M3b: sidebar shell, Rules UI, small-GPU profile

Branch `m3b`. Decisions: [ADR 0002](adr/0002-small-profile-cpu-classifier-and-tasks.md) (CPU classifier and tasks), [0003](adr/0003-left-sidebar-app-shell.md) (sidebar), [0004](adr/0004-rules-overrides-and-versioning.md) (rules overrides). Screens: `docs/screens/m3b/`.

## What changed, in the order of the brief

### Commit 1: engineering principles
`CLAUDE.md` gained the eight engineering principles and the decision protocol; `docs/adr/` started with [0001](adr/0001-record-architecture-decisions.md). Every decision below has an ADR.

### Commit 2: small profile + Gemini limits
- `config/local-models.yaml` `small`: Arch-Router and `llama3.2:3b` run on the CPU (`num_gpu: 0`, 1 h keep-alive); only `qwen3:4b` uses the GPU. `max_loaded` now counts GPU models only. New profile keys `tasks_options` and `tasks_keep_alive`.
- Titles and summaries go through one **low-priority queue** (`app/local_queue.py`): one at a time, never while a classification is in flight, bounded at 16, a timed-out waiter gives its place back.
- Measured before/after: [docs/m3a.md](m3a.md#m3b-classifier-and-tasks-model-on-the-cpu-small-profile-before-and-after). 100% keyword-heuristic fallbacks after a local reply → 0%; accuracy unchanged (96.2%, held-out 92.5%); classifier p95 0.96 s alone, 1.23 s while a title job runs (limit 1.5 s, not raised).
- `providers.yaml`: the owner's Gemini free-tier limits (2026-11-19, India, free tier). Quota limits accept glob model keys and `0` = no free access (the guard treats it as 100% used for automatic routing and manual picks). Verified for one account: the guard also learns from headers and 429s.
- `scripts/measure-local.py` reproduces the numbers on any machine.

### Housekeeping
- hostprobe: `claude auth status --json` (only the boolean `loggedIn` is read; email and org are discarded) and `codex login status` verified against the real Linux binaries; both outputs are test fixtures. [docs/m1a.md](m1a.md) table updated. doctor shows both "logged in".
- Visual flake fixed at its root: gallery sections use `content-visibility:auto`, so each was a 708 px placeholder until scrolled to, and a capture could land before or after the lazy render. The capture now renders every section first (`renderAllSections`). A second one appeared in this milestone's own new baseline (sticky chrome painted at the scroll position a click left behind, plus a table that scrolled sideways inside its box); both fixed in the layout and the test, no threshold touched. Evidence: 3 × 312 consecutive visual passes under 8-way load.
- PROGRESS "Future" section.

### A. Sidebar
See ADR 0003 and the screenshots. Behaviour:
- **Top:** logo, collapse (⌘B), New chat, Search (⌘K opens the palette). **Nav:** Chat, Studio, Jobs, Connections, Metrics, Status. **Recents:** global, grouped (Pinned, Today, Yesterday, Previous 7 days, Older), paginated ("Show more"), searched on the server, row menu (rename, pin, delete), one tab stop with ↑/↓/Home/End, F2 renames, Delete asks. **Bottom:** budget Dial (today's spend against the daily cap), breathing health dot (opens Status), Simple/Pro, Appearance, Settings, profile.
- **Collapsed** (4.75 rem rail, tooltips) survives reloads (set before paint). **Phones:** drawer with a focus trap, Esc to close (focus returns to the menu button), the page behind it inert.
- `GET /chat/threads?limit&cursor&q` is keyset-paginated with an index (migration 0006); the chat page no longer loads or renders a thread list.
- The footer lost what the sidebar now shows (service health, today's spend) and kept quota, value saved, version and links.
- **Layout test** (`tests/m3b-shell.spec.ts`): 6 widths (360/768/1024/1280/1440/1920) × 8 pages, 6 zoom cases (125%/150% of 768/1024/1280/1920), asserting no sideways scroll and that no sidebar control is outside the window or the sidebar. It found, and this milestone fixed: reply actions overflowing at 360 px, Connections and wizard grids that switched columns at viewport breakpoints (now `auto-fill`), and the wizard's two columns (now from 1280 px).

### B. Rules UI (`/settings/rules`, linked from Settings → Routing and the palette)
- **Simple mode:** the three presets with the active one marked, the paid policy per preset, and the tester. **Pro mode:** tabs Presets, Rules, Commands & classifier, History.
- **Rules:** table (order, rule, when, goes to) and a form (conditions, target and ordered fallbacks with up/down buttons, temperature, autonomy, cost cap, job flag), add, remove (restorable), reset a rule to `rules.yaml`. The `private` rule shows a lock, offers local targets only, has no fallbacks and can't be removed.
- **Validation** is the router's: the editor asks `POST /rules/validate` shortly after each edit and puts each message next to its field; Save is blocked while anything is flagged. Messages are plain sentences with the fix.
- **Versions:** every save is a version (optional note). History shows who/what/when, a diff against the previous version, and rollback (which saves a copy, so nothing is lost). A stale editor gets "changed somewhere else" and nothing is overwritten. Saving the same document again is a no-op.
- **Tester:** `POST /route/dry-run` returns the decision, the classifier's answer (source, route, ms, fallback reason), the order targets would be tried, reasons, per-factor score breakdown (Pro) and the runner-up. Unsaved changes are sent as a `draft` and never persisted.
- **Live preview:** the editor merges the draft onto the base itself to show the effective table. That merge mirrors the router's; both run the same cases (`services/router/tests/fixtures/rules_merge_cases.json`) so they can't drift apart.
- **Tuning the classifier:** edit the `sensitive_*` descriptions in Commands & classifier, save, then `eval-routing.py --saved-rules` measures the result.

## Checks
- Router: 306 pytest (227 at M3a), ruff clean. hostprobe: 64 unittest (58).
- Portal: 83 vitest (61); **322 Playwright, three consecutive full runs at 8 workers** (244 functional including axe serious/critical none in both themes on every page, the expanded and collapsed sidebar, the drawer, Rules Simple and every Pro tab, plus 78 visual baselines); eslint, tsc and the bundle check (admin token never reaches the browser) clean.
- First-load JS (gzip): `/chat` 197.7 → 196.0 KB, `/settings/rules` 188.7 KB, `/welcome` 197.4 → 198.9 KB (the tightest), the other routes +0.5 to +1 KB.
- Lighthouse (mobile profile): performance 94–100, accessibility 100, best practices 100 on every route including the new Rules page (CLS 0); `/chat` 94 / 92 (light / dark). It caught two regressions on the way, both fixed at the cause: `/chat` dropped to 87 (the recents list now loads when the page is idle, not while it hydrates) and Rules had CLS 0.064 (its panels are lazy chunks but rendered on the server, so the HTML is already final size).
- Live (real stack): router rebuilt, migrations 0005 and 0006 applied, `GET /rules`, validation of a bad document, three dry runs with the real Arch-Router on the CPU (a draft change moved the decision from Gemini to Groq; a health message stayed local), nothing persisted. `doctor.sh` all green (claude and codex "logged in").
- Found by the new tests and fixed (not worked around): reply actions overflowing at 360 px; viewport-breakpoint grids on Connections and the wizard; a rules table that scrolled sideways inside its box (and made a screenshot flaky); a tab-focus call that ran before the panel swap committed; sticky chrome painted at the scroll position a click left behind.

## Decisions taken without asking, for review
You were away, so these reversible choices were made on the recommended option and recorded:
1. **Rules at `/settings/rules`**, not a seventh nav item (as agreed in the plan).
2. **Simple mode = presets + tester**, including each preset's paid policy; editing a preset's per-rule overlay is Pro. (Your brief said "presets only"; this is the narrowest reading that still lets Simple change something useful.)
3. **A preset's active state is not part of the draft:** "Use this preset" saves at once (it is the wizard's saved preset), the rest waits for Save.
4. **Built-in classifier routes keep their facts** (only the wording is editable), so a sensitive route can't be re-labelled into a non-sensitive one.
5. **Targets already in `rules.yaml` stay valid even if their alias doesn't exist yet** (`model:grok`), so editing another field of that rule isn't blocked; a new unknown alias is refused.
6. **Fixture validation in the portal is deliberately partial** (the cases the UI tests use); the router's validation is authoritative and has its own 53 tests.
7. **Container queries** for the rules table (Order and When columns drop below 512 / 576 px of box width), because the sidebar makes viewport breakpoints misleading.
8. **No version pruning yet** for `rules_versions` (rows are small and rarely written); listed as a carry-over.
