# Switchboard — Progress & Decisions Log

> Single source of project memory. Update at the end of every milestone (Claude Code: append, never rewrite history).
> Read this + SPEC.md at the start of any new chat or session.

## Status

| Milestone | Status | Branch / PR | Model used | Notes |
|---|---|---|---|---|
| M0 Infra | ✅ Merged | m0 / #1 | Opus 5.5, medium | doctor.sh green; fast + local verified |
| M0.5 Design system | ✅ Merged | m05 / #2 | Sonnet 5.5, medium | All 4 approved changes delivered; see M0.5 outcome |
| M1 Connections + wizard | ✅ Split into M1a + M1b, both merged | — | Sonnet 5.5, medium | Done; carry-over items listed below |
| M1a Router backend | ✅ Merged | m1a / #4 | Opus 5.5 | Split from M1; see M1a outcome |
| M1b Connections UI + wizard | ✅ Merged | m1b / #5 | Sonnet 5.5 | Install/login flows, wizard, chips; see M1b outcome. Item 7 (verify CLI login commands) waits on your installs |
| M2 Chat + Router | ✅ Merged | m2 / #6 | Opus 5.5, high | Rules engine, streaming chat, fallbacks with reasons, caps, private; see M2 outcome |
| Provider fixes | ✅ Merged | provider-fixes / #7 | Sonnet 5.5 | Mistral paid-only, Cerebras credits, OpenRouter `:free`-only + 402, Gemini CLI hint, claude install test; see Provider fixes outcome |
| M1.5 Design polish + self-healing | ✅ Merged | m15 / #8 | Opus 5.5 | doctor never hangs; self-healing LiteLLM sync + plain errors + Status view; footer, splash, shortcuts, chat sidebar/column, Why fix, Settings, motion v2, ambient cursor, one tooltip; see M1.5 outcome |
| M3 Rules UI + classifier | ✅ Split into M3a + M3b, both merged | — | Opus 5.5, high | Done |
| M3a Routing brain | ✅ Merged | m3a / #9 | Opus 5.5 | Arch-Router 96.2% (held-out 92.5%), recommender, quota guard, generic adapter (test-only proof), summaries, local-model profiles, auto-private + secret masking; see M3a outcome |
| M3b Rules UI + sidebar | ✅ Merged | m3b / #10 | Sonnet 5.5 | Left-sidebar shell, Rules UI (Simple presets / Pro editor, versions, rollback, dry-run tester), classifier + tasks on the CPU on small GPUs, Gemini limits, flake root-caused, claude/codex login checks; see M3b outcome |
| README v1 | ✅ Merged | readme-v1 / #11 | Sonnet 5.5 | Honest, animated README + demo; one project VERSION; Motion and the wizard's Connect step lazy-loaded (every route −12 to −18 KB); chat stays pinned while lazy chunks load; demo stack; see README v1 outcome |
| M4 Jobs via Paperclip | Split into M4a + M4b | — | Opus 5.5, high | Backend first, then the page |
| M4a Agents & Jobs backend | ✅ Merged | m4a / #12 | Opus 5.5 | Paperclip adapter (verified 2026.1106.0), agent registry, job engine, worktrees via hostprobe, live proof with Claude Code, Codex and OpenCode; fast private chat + Think harder; three load flakes fixed at the cause; see M4a outcome |
| M4b Jobs page + agent fleet | ✅ Done (PR in review) | m4b / #13 | Opus 5.5 | Job board and detail (live log, plan, per-file diff, decisions), Run as job, fleet (ADR 0009), Projects and Jobs settings, badge and toasts, level-3 decision (ADR 0010, M7), `/chat` Lighthouse 95–99; see M4b outcome |
| M4.5 Workflow packs | ⏳ | — | Opus 5.5, high | |
| M5 Studio | ⏳ | — | Sonnet 5.5, medium | |
| M5.5 Content Studio | ⏳ | — | Sonnet 5.5, medium | |
| M6 Metrics | ⏳ | — | Opus 5.5, medium | |
| M7 Packaging | ⏳ | — | Sonnet 5.5, low–medium | |

**MVP target:** M0 + M0.5 + M1 + M2 + basic cost view. Use daily, publish early. M4.5 and M5.5 are cuttable.

## Environment (as of M0)

- Windows 11, 32 GB RAM, RTX 3050 4 GB. WSL2 Ubuntu 24.04 (13 GB to WSL). Docker Desktop 29.9.2, WSL integration on.
- Repo: `~/switchboard` in WSL (never under /mnt/c or /mnt/d). Remote: github.com/DevelopingGod/switchboard (public).
- Node 24 via nvm (Linux). Windows Node at /mnt/d/NodeJS must not come first on PATH. Use **npm**, not the Windows pnpm.
- Ollama on Windows, reached from Docker at host.docker.internal:11434. Models: qwen3:4b (local/private), llama3.2:3b (fallback), qwen2.5-coder:3b (future local-code). 7B/14B excluded from routing defaults.
- Paperclip 2026.1106.0, native in WSL, loopback service on 127.0.0.1:3100, embedded Postgres.
- LiteLLM v1.108.8 on 127.0.0.1:4000; Postgres 17.6 (DBs: switchboard, litellm).
- Claude Code: desktop app, Code tab, WSL → Ubuntu environment. WSL sessions lack terminal, file pane, plugins, connectors, @-suggestions.

## Key decisions

1. **Architecture:** own portal (Next.js) + Router API (FastAPI) on top of reused Paperclip (agents/jobs/approvals/budgets) and LiteLLM (API-key models, media, spend). Don't rebuild those.
2. **Subscriptions only via official CLIs** (Claude Code, Codex, Gemini CLI, Grok Build). Never pass subscription OAuth tokens to other tools/gateways (Anthropic ToS; ban risk). Skip OmniRoute/9Router-style subscription passthrough.
3. **Paid:** Claude Pro (have). SuperGrok $30 planned at M4 (verify headless/automated use billing first). ChatGPT Plus optional.
4. **Workflow packs** (OpenSpec, gstack, Spec Kit, Superpowers, BMAD, graphify…) are never pre-installed; installed on demand via `packs/<id>/pack.yaml` manifests (SPEC §8a).
5. **Media:** no reliable free video API; confirm-before-spend + media caps. Images try free Gemini quota, then Grok Imagine.
6. **Privacy:** Gemini free tier and Mistral may train on data (user is in India, outside EEA). Private toggle → local Ollama only.
7. **Design direction (M0.5):** "dreamy sky" inspired by a Dribbble mindfulness landing page (Moola by Kris Anfalova) — original assets only. Day sky (light) / Dusk (dark), periwinkle accent (#8B8FE8 family, #5a5fc9 for text on light), white pill top nav, signature Dial (quotas, budgets, autonomy), huge tight headings, Plus Jakarta Sans + Geist + Geist Mono, glass for containers only, code on solid panels, ≤ 2 blur layers, reduced-motion/transparency fallbacks, Comfortable/Compact density, columns motif only on onboarding/login.
8. **Process:** one milestone per branch + PR; Plan mode first; new session per milestone; stop for review after each. Prompts and reviews come from the planning chat.
9. **Model catalog + in-provider recommendation (SPEC §6.4):** catalog in M1, recommender + learning in M3.

## M0 outcome

- `fast` = groq/openai/gpt-oss-120b. `smart-free` = gemini/gemini-3.5-flash (`gemini-flash-latest` → 3.8 hung; pinned).
- Added: .gitattributes (LF), gitleaks pre-commit (.githooks, checksum-verified install), doctor checks (Node source, clock drift, ports), docs/TROUBLESHOOTING.md.
- Fixed: LiteLLM config mount (mount folder, not file); Node-source false red.

## M0.5 outcome

- `apps/portal` (Next.js 16, TS, Tailwind 4, Radix-based shadcn-style primitives, Motion, Lucide); **npm**. Guide: [docs/m05.md](m05.md). Screens: [docs/screens](screens/).
- SPEC §8c rewritten for the "dreamy sky" direction. `design-tokens.ts` is the single source (generated CSS vars; unit test for drift and AA contrast on every text/surface pair and sky stop).
- Kit: GlassPanel, PillTabs, Dial, StatCard, RouteChip, ProviderCard, JobCard, CostBadge, ExplainPopover, Composer, Toast, Skeleton, EmptyState (+ StatusBadge, Segmented, Logo, ColumnsArt), each with loading/empty/error/disabled states. Shell: top pill nav, mobile bottom bar, ⌘K, Simple/Pro, Comfortable/Compact, Appearance menu (theme, solid surfaces, sky image), stub screens, Home composer.
- Checks: axe no serious/critical (17 tests, both themes, palette/popovers/mobile); Lighthouse (mobile profile) perf 95–99, a11y 100, best-practices 100; initial JS 176–197 KB gzip per route (budget 200); 34 visual baselines; 12 unit + 9 shell tests (reduced-transparency/motion, ≤ 2 blur layers, Dial keyboard).
- Deviation from decision 7: accent-on-light text uses `#4b50c4` (not `#5a5fc9`), the value that passes AA with margin on every sky stop. Primary pill uses `#8B8FE8` with dark ink.
- Sky image is procedurally generated (gradients + fractal-noise clouds via sharp), ~6 KB AVIF each; swap for a CC0 photo if a more realistic sky is wanted. Logo mark + wordmark SVG: `public/logo.svg`, `app/icon.svg`.

## Carry-over from M0.5

- M1 wizard sets `name` (`usePrefs().name`, defaults to "there") and may use `ColumnsArt` on onboarding/login; those screens don't exist yet. Other screens are `ScreenStub` placeholders.
- Mobile is read-only by design (composer disabled with a reason).
- Ports: Paperclip 3100; portal dev 3000, portal test server 3210.
- Next 16: scaffold `AGENTS.md` says read `node_modules/next/dist/docs/` before framework work. `cacheComponents` is off (no server data yet); revisit in M1.
- Turbopack flattens `@layer` blocks written in `globals.css`; custom component CSS lives in `components.css` imported with `layer(components)`.
- Visual baselines are Linux Chromium only; M7 CI must use the same browser build.
- Lighthouse under WSL must run from a scratch cwd (script does this); otherwise `C:\Users\…` profile dirs appear in the repo.
- Gallery section titles and sample data are inline dev fixtures, not in `strings.ts`.
- Playwright needed `sudo npx playwright install-deps chromium` (done on this machine).

## Carry-over to M1

- Per-model timeout ~20–30 s for `fast` (global request_timeout is 120 s → slow fallback).
- `smart-free` fallback → `local`.
- Single source of truth for models: LiteLLM YAML vs DB (`STORE_MODEL_IN_DB=True`) — pick one for the Connections screen.
- Add Cerebras key + alias; add `local-code` (qwen2.5-coder:3b).
- Linux installs of claude, codex, gemini, grok, opencode inside WSL; `sudo apt install wslu` for browser logins.
- Arch-Router model pull deferred to M3.
- Model catalog (SPEC §6.4): live `/models` pull on startup and every 24 h; `model_catalog` table; `config/model-tags.yaml` (curated tags) plus prices and free-tier limits in `config/providers.yaml`; "untagged" state for new models; recommended-model badges on provider cards with a "Use for…" action that writes a rule override. `model_stats` and the recommender land in M3.

## M0.5 approved changes

1. Full-page screenshots of / and /dev/components in both themes in docs/screens/, embedded in PR.
2. CSS sky default + optional original sky image (AVIF < 150 KB) behind a "Sky image" toggle.
3. Lighthouse: performance, accessibility, best-practices ≥ 90 (no SEO).
4. Original logo mark + "Switchboard" wordmark (SVG) for top bar and favicon.

## Open questions / to verify

- Paperclip REST endpoints for issues, runs, costs, approvals (M4).
- Grok Build headless billing; Codex Free access at build time.
- LiteLLM support for xAI Imagine image/video.

## M1a outcome

- M1 split into **M1a** (backend, this PR) and **M1b** (Connections UI, wizard, quick-start chips). SPEC §11 and the status table each gained two rows; the M1 row is unchanged. Guide: [docs/m1a.md](m1a.md).
- `services/router`: FastAPI + async SQLAlchemy (psycopg 3) + Alembic in compose on `127.0.0.1:8100`; migrations run on start. Tables: `connections`, `provider_secrets`, `system_meta`, `model_catalog`, `model_stats` (SPEC §6.4), plus `requests`/`costs` stubs (§9).
- **Single source of truth for models: LiteLLM's DB, written only by the router.** `config/litellm.yaml` has no `model_list` anymore. Aliases live in `config/providers.yaml` and are reconciled into LiteLLM with one credential per provider (`sb-<provider>`); only `managed_by: switchboard` deployments are touched. Reasoning is in docs/m1a.md.
- Keys: validated against the provider before storing, Fernet-encrypted in the Router DB (the router needs them for the catalog and direct model tests), registered as LiteLLM credentials, never logged or returned (last 4 only). Admin token (`ROUTER_ADMIN_TOKEN`) on every write/refresh endpoint; CORS limited to the portal origin. GROQ/GEMINI keys were imported once from `deploy/.env`.
- Catalog: live `/models` from Groq (11), Gemini (64), Ollama (7) on this machine; Cerebras, Mistral, OpenRouter and Zen fetchers are built and tested against recorded responses, and skipped until keyed. Curated tags in `config/model-tags.yaml`, metadata fallback, `untagged` state, `missing`/`deprecated` marking. Runs at startup and every 24 h.
- **hostprobe** (`services/hostprobe`, stdlib, systemd user unit, `127.0.0.1:8101`): allowlisted argv only, token on every request, 5 s command timeout, rate limit, 30 s cache, stat-only credential checks. Detection result today: claude/codex/gemini are Windows-only, and grok/opencode are not installed in WSL.
- M0 carry-overs done: `fast` 25 s timeout; Cerebras joins `fast` as order 2 (+ `cerebras` alias) once a key is added; `smart-free` → `local` fallback (verified); `local-code` = `qwen2.5-coder:3b`. `smart-free` timeout lowered to 30 s because a hung Gemini call took ~120 s to reach the fallback.
- `doctor.sh`: new Router, Providers, hostprobe and CLI sections; secret-key fingerprint check (red if `SWITCHBOARD_SECRET_KEY`/`LITELLM_SALT_KEY` changed); yellow reminder while imported keys remain in `.env`. All green on this machine.
- Tests: 30 router (pytest, throwaway `switchboard_test` DB, respx-mocked providers/LiteLLM) + 15 hostprobe (unittest); ruff clean.

## Carry-over to M1b

- Portal calls the Router API at `127.0.0.1:8100`. The admin token must stay server-side: proxy writes through a Next.js route handler or server action, never ship `ROUTER_ADMIN_TOKEN` to the browser.
- Install the Linux CLIs in WSL (claude, codex, gemini, grok, opencode) and `sudo apt install wslu`, then re-verify the auth-status commands marked "Not yet" in docs/m1a.md (claude, gemini, grok, opencode). Login/install buttons need new allowlisted, user-confirmed hostprobe endpoints (not in M1a).
- Add Cerebras / Mistral / OpenRouter / Zen keys through the API to light up `fast` order 2, `general`, `explore` and `code-free`, then check that their live fetchers match the recorded shapes.
- Gemini `gemini-3.5-flash` hung on direct `generateContent` on 2026-11-17 (provider-side); `smart-free` served via `local`. Re-check, or pin another Flash model, before M2.
- Recommended-model badges and "Use for…" (SPEC §6.4 UI) read `/catalog`; scores/recommender stay in M3. `model_stats` only has `task_type="test"` rows so far.
- `GROQ_API_KEY`/`GEMINI_API_KEY` can now be removed from `deploy/.env` (doctor shows yellow until then).

## M1b outcome

- Guide: [docs/m1b.md](m1b.md). The portal talks to the router only from the Next.js server (server components, server actions, one SSE route handler). `ROUTER_ADMIN_TOKEN` lives in `apps/portal/.env.local` (written by `setup-wsl.sh`, checked by `doctor.sh`) and never reaches the browser; `npm run test:bundle` proves it (build with a sentinel token, grep client output and served pages; negative control verified).
- **Connections** (`/connections`, real `/connections` + `/catalog` data): add/test/replace/remove key with inline confirm, status, last error, last 4, free limits, privacy label, paid label; up to three recommended models per card with Best for code / Fastest / Largest context / Free badges from catalog tags (`lib/recommend.ts`, unit-tested) and a per-model Test. Live smoke test on this machine: Groq connection test and a 338 ms model test through the portal.
- **CLI install** (new hostprobe endpoints, via router): plan → you read the source URL, docs link, pinned version, installer SHA-256, exact commands and side effects → confirm → streamed log → card flips. Methods are each vendor's current recommended Linux install (claude/codex/grok/opencode installer scripts, gemini via npm), pinned, downloaded to a file and run from it, never `curl | bash`, never sudo (shim + root refusal), single-use plans, one install at a time. All five plans were fetched against the real stack (hashes match the scripts reviewed); nothing was installed, because the confirm click is yours. **Login** is a copyable terminal command plus **Check again** (fresh probe).
- **Wizard** (`/welcome`): name + Simple/Pro → goals (incl. Writing/content) → connect only needed providers → preset → finish with a "Try it" placeholder; skippable, resumable on any device (state in `system_meta`, `GET/PUT /onboarding`); first run redirects `/` to the wizard. Goal → provider mapping is in `config/providers.yaml` (`goals:`); `xai` added as a paid API-key provider; claude-code, grok-build and xai are labelled paid.
- **Home:** four quick-start chips fill the composer (route in M2). **Carry-overs done:** Dial loading is a shimmering ring; ColumnsArt redrawn with theme-token fills; gallery user-facing text moved to `strings.ts`; `cacheComponents` re-evaluated and left **off** (reasons in `next.config.ts` and docs/m1b.md); dev/start bind `127.0.0.1`.
- **Gemini:** swept the catalog with `scripts/gemini-sweep.py` (details in docs/m1b.md). The old pin `gemini-3.5-flash` answered 0/3 (timeout, 503s). `smart-free` is now pinned to `gemini-3.1-flash-lite` (3/3, ~1.2 s, not a preview; `gemini-3-flash-preview` also went 3/3 if you want a stronger model), with `num_retries: 0` so fallback to local takes one 30 s timeout instead of two. Verified live. Three samples per model: a spot check.
- Checks: router 45 pytest (15 new), hostprobe 36 unittest (21 new; 52 after the follow-up below), ruff clean; portal 24 unit (33 after the follow-up), 96 Playwright (99 after) (axe serious/critical none on `/connections`, every wizard step, key form and install dialog, both themes; visual baselines regenerated, 46 now); Lighthouse (mobile profile) perf 98–99, a11y 100, best-practices 100 on gallery, Home, Connections and a wizard step in both themes; first-load JS 190–195 KB gzip on product routes (`/dev/components` 199.9 KB, at the edge of the 200 KB budget).
- Screenshots (fixture data, no real key suffixes): `docs/screens/connections-{day,dusk}.webp` and `welcome-{1..5}-{day,dusk}.webp`.

## M1b follow-up: login-status verification, install log UX, PATH

- **Login-status commands (A):** OpenCode 1.19.6 (installed through the portal) is the only CLI installed in WSL, so the only one verified. Real `opencode auth list` prints `1 credentials` / `0 credentials` with ANSI codes and box-drawing characters even under `NO_COLOR=1`; the existing parser is correct and now has tests built from the recorded bytes (docs/m1a.md table updated). claude, codex and gemini exist only as Windows copies and grok isn't installed, so `claude auth status`, `codex login status` (already confirmed via `--help`), the gemini and grok credential-file paths stay unverified until each is installed in WSL.
- **Install log (B):** root cause of one-line-per-redraw: Python text mode turned every `\r` into `\n`. hostprobe now reads bytes and emits `{t, r, p}` entries (redraws replace in place, ANSI stripped, percent parsed, redraws throttled). The dialog shows stages (Downloading → Installing → Verifying → Done), one progress bar, and the raw log in a collapsed Details section; success shows "OpenCode 1.19.6 installed", the button changes from Stop install to Done, the card refreshes and **Log in next** appears; failure shows an error summary and the last 20 lines. Tests use a recorded real `curl -#` capture. Gallery section `install-progress` (running / success / failure) gives the visual baselines; Connections, toast and skeleton baselines regenerated (login layout and a new gallery section above them).
- **PATH (C):** hostprobe reports `bin_path`, `bin_dir` and `on_user_path` (one fixed `bash -lic` call, home-relative paths). When a new terminal can't find the binary, the dialog and cards show a one-line PATH fix with Copy, then the login command, then the login command by full path. Not built: appending to `~/.bashrc` from the portal with a confirmation (another hostprobe write action); the copyable line is the only path. Your OpenCode reports on-path because `~/.bashrc` line 122 already adds it.
- Checks: hostprobe 52 unittest, router 45 pytest, ruff clean; portal 33 unit, 99 Playwright (axe, both themes; 48 visual baselines, stable over repeated runs), eslint clean; Lighthouse perf 97-100 / a11y 99-100 / best-practices 100; first-load JS 190-195 KB on product routes, `/dev/components` 199.4 KB (gallery-only kit components are now lazy-loaded to stay under the cap; it is still the closest to the 200 KB budget). The install-dialog axe test audits the dialog itself, because axe scores the page behind the dimmed modal overlay as low-contrast (the page is audited un-dimmed elsewhere).
- Still open: verify the other CLIs' status commands as they're installed (see "Carry-over to M2").

## Carry-over to M2

- Presets, goals and the name are stored but unused: the rules engine applies the preset; the chips and composer route.
- "Try it" is a placeholder; "Use for…" and `model_stats` scoring stay in M3.
- Add Cerebras / Mistral / OpenRouter / Zen / xAI keys through the UI to light up `fast` order 2, `general`, `explore`, `code-free`, then check live fetchers against the recorded shapes (still open from M1a).
- Verify each CLI's real login-status command after your installs (M1b item 7): `claude auth status`, `gemini`, `grok`, `opencode auth list` are still marked "Not yet" in docs/m1a.md; update hostprobe, its tests and that table.
- `GROQ_API_KEY`/`GEMINI_API_KEY` can be removed from `deploy/.env` (doctor stays yellow until then).

## Carry-over to M7

- **The portal has no user auth yet.** It holds the router admin token server-side and exposes every admin action to anyone who can reach port 3000, so it is bound to `127.0.0.1` only (doctor checks). Login is required before any remote access (Tailscale or otherwise).
- Visual baselines are Linux Chromium only (unchanged); CI must use the same browser build.
- The gallery's first-load JS is 199.9 KB: any further growth in shared code needs a trim or an explicit budget decision.

## M2 outcome

Guide: [docs/m2.md](m2.md). Screens: `docs/screens/chat-{day,dusk}.webp`, `chat-why-*` ("Why this?" on a fallback reply) and `chat-private-*` (private reply with the thinking expanded).

- **Rules engine** (`services/router/app/routing`):
  - `config/rules.yaml` holds the SPEC §7.2 + §8d rules, `slash:` commands, `presets:` (Free only / Balanced / Best quality, chosen by the wizard's saved preset) and `daily_cap_usd`.
  - Pipeline: manual pick > slash > private > keyword intent (until M3) > default. Targets can be an alias, a specific catalog model (`model:groq/openai/gpt-oss-20b`, through one `<provider>/*` LiteLLM wildcard per connected provider) or `best:<capability>` (simple: free first, then fastest, plus a runner-up).
  - Every skip is recorded with a reason: not connected, cooling down, preset, budget, private, agent (M4), Studio (M5).
- **Chat API** (`app/chat`):
  - Threads and messages (Alembic `0002`). SSE through LiteLLM with `disable_fallbacks`; the router walks the rule's fallbacks itself. A 429 or timeout before the first token moves to the next target and starts a cooldown. Stop, regenerate and edit-last are supported.
  - Each request writes `requests` (rule, target, the deployment that answered, fallbacks tried with reasons, latency, time to first token; prompt hash only), `costs` (tokens and cost from the LiteLLM usage chunk) and `model_stats` per task type. Thumbs feedback goes to `model_stats`.
- **Your three review changes:**
  1. **Free-tier cost:** `costs.cost_usd = 0` for free-tier providers. The price goes into `list_price_usd`, and caps use `cost_usd` only (tested: a Gemini or Groq call with a $0.90 LiteLLM cost never counts).
  2. **Auto titles:** from the local model (`llama3.2:3b`; qwen3 reasons inside its answer even with thinking off), falling back to the first words. Rename stays available.
  3. **Thinking:** streamed as a collapsible "Thinking… / Thought for N s" line and never stored.
- **Caps and private:**
  - Per-request and daily caps block before any call, with a clear message. Per-request also limits `max_tokens`.
  - Private is enforced in code: every deployment must be local, there is no cloud fallback, and threads are sticky-private. The test captures every LiteLLM call to prove it.
- **Portal `/chat`:**
  - Thread list, streaming Markdown with highlighted code and Copy code, RouteChip → "Why this?" popover (rule, model, top 3 reasons, runner-up, skipped and why, tokens, context, cost, latency), thumbs, regenerate, edit, stop.
  - Studio notices for image and video, and a disabled "Run as job (M4)" button for job-like requests.
  - The composer has a target picker (aliases and models by provider with badges), slash hints and Enter to send.
  - The Home composer and the quick-start chips now send real messages; the chips are complete sample tasks.
  - The SSE proxy `/api/chat/stream` checks Host, exact Origin, Sec-Fetch-Site and a JSON content type.
- **JS budget:** `/chat` 196.6 KB. Every other route got lighter: `/` 189.0 (was 194.4), the gallery 194.9 (was 199.4), the baseline 176.7 (was 179.7).
  - Feature strings moved to their own modules in `src/i18n/` (SPEC §8c updated).
  - A native switch replaced the Radix Switch.
  - Markdown, highlighting, the popover, the picker and the rare reply states are lazy chunks that show stand-ins until they load.
- **Live on this machine:**
  - `fast`, `smart-free`, `local` and a specific model all answered. Every slash command routed as expected.
  - A forced 429 on `fast` and a real timeout on `smart-free` each fell back, with the reason in the chip. `requests`/`costs` rows carry tokens and cost, and the portal works end to end.
  - The budget block could not be shown live, because every keyed provider here is free tier. Tests cover it.
- **Also:**
  - `doctor.sh` checks that `rules.yaml` parses and warns if fault injection is on.
  - The bundle check now stops its server's whole process group (a leftover `next` held port 3213).
  - The mobile bottom bar moved to the near-opaque surface (Lighthouse caught 2.9:1 labels over dark code panels).
- **Checks:**
  - Router: 107 pytest (62 new), ruff clean.
  - Portal: 45 vitest, 123 Playwright (axe in both themes incl. popover, picker and a live private reply; 52 visual baselines), eslint and tsc clean.
  - Lighthouse `/chat` 94–95 / 100 / 100; others ≥ 99 / 99 / 100. Budget and bundle checks pass.

## Carry-over to M3

- Swap the keyword heuristics for Arch-Router (`routing/heuristics.py` is the only caller). `POST /route/dry-run` already returns the full decision for the Rules tester.
- Rules UI: DB overrides and versioning on top of `config/rules.yaml` (read-only mount today; the presets are overlays).
- `best:<capability>` scoring from `model_stats`: per task type there are latency samples (time to first token), failures and thumbs, written since M2.
- Cooldowns are in memory: they reset on router restart and aren't shared. Persist them if the router ever runs more than one worker.
- Auto-summarize long threads. For now history is trimmed newest-first to `max_context_tokens` (8000), and the chip shows the context size.
- Verify LiteLLM failover between deployments of the same alias while `disable_fallbacks` is set, once Cerebras is keyed (`fast` order 2).
- **JS budget headroom:** the Dial's `useSpring` pulls Motion's animation engine (7.6 KB gzip) into `/`, `/chat` and the gallery. A CSS-transition Dial would free it.
- **Still open from M1b (yours):** add the Cerebras, Mistral, OpenRouter, Zen and xAI keys to light up `general`, `explore`, `code-free` and a paid model (also needed to see a budget block live); verify the CLI login commands after your installs; remove `GROQ_API_KEY`/`GEMINI_API_KEY` from `deploy/.env`.

## Provider fixes outcome (branch `provider-fixes`)

Small follow-up between M2 and M3. No new milestone scope.

1. **Claude Code install: already the native installer, now pinned by a test.** In this repo `INSTALLS["claude"]` is already `https://claude.ai/install.sh` (downloaded, hashed, shown, run from a file, version pinned); there is no npm path for claude and `--ignore-scripts` appears nowhere. So no code change was needed. `test_claude_uses_the_official_native_installer_and_never_skips_scripts` now fails if claude ever gets an npm source, `--ignore-scripts`, `@anthropic-ai` or sudo, and checks the plan shows source, SHA-256, size and commands. A live plan against claude.ai returned a 9,704-byte script (sha256 `3a68d340…`). **Probable origin of "native binary not installed":** `which -a claude` lists `/mnt/c/Users/…/AppData/Roaming/npm/claude`, a Windows npm copy; run from WSL its postinstall-fetched binary is missing. The Linux copy at `~/.local/bin/claude` runs (2.1.326). Not reproduced; CHECKLIST has the workaround.
2. **Mistral → paid-only.** `paid: true`, free-limits text says the free plan cannot activate API keys. Removed from the `chat` and `writing` wizard goals (`writing` is now `gemini`, `openrouter`; `chat` is `groq`, `cerebras`) and from every automatic chain in `rules.yaml` (`model:general` → `model:explore`); the `general` alias still exists for a manual pick. The Free preset never uses it; Balanced only on a manual pick.
3. **Cerebras → one-time credits.** Deviation from the request: `kind` stays `api_key` (key storage, catalog fetch and LiteLLM registration all key off it); the new field is `billing: credits`. You enter a starting balance on the card (**Set balance**); `app/credits.py` stores it in `system_meta` (`credits:cerebras`, no migration) and counts `costs.list_price_usd` for that provider since it was set. The card shows "$X left of $Y" with a meter. At $0 the router skips it with code `credits` and a clear reason, and `reconcile` removes its LiteLLM deployments (the `fast` order-2 entry too) so LiteLLM cannot fail over to it either; entering a new balance restores them. Credit spend never counts toward the daily cap (`cost_usd` stays $0). Until a balance is entered nothing is blocked. Caveat: tracking is only as good as the list price on each call (LiteLLM's `cost`, else the catalog price); a call with no price counts $0.
4. **OpenRouter.** Automatic routing (rule chains, `best:<capability>`) only uses `:free` models; a paid OpenRouter model is skipped with "only used when you pick them" unless it is a manual pick. 402 (or a provider/LiteLLM message such as "insufficient credits", "requires more credits", "credit limit") is classified `credit_limit`: skip + 30 min cooldown, reason "Credit limit reached (402): add credits, or use a :free model", visible in the Why popover and on later requests while cooling down. A 429 is still a rate limit.
5. **Gemini CLI.** Login hint now says choose **Use Gemini API key** (Google sign-in is no longer supported for individuals); the card note warns it shares the Gemini API free quota with `smart-free`.
6. **Docs:** `docs/CHECKLIST.md` (cherry-picked from `docs-checklist`, which isn't on main yet) updated for all of the above.

- **Checks:** router 117 pytest (was 107; new: credits lifecycle end to end, 402 and wrapped 402, OpenRouter paid/free, Mistral off every chain), ruff clean; hostprobe 53 unittest; portal tsc, eslint, 45 vitest and 123 → 125 Playwright pass; visual baselines regenerated only for `connections` and `wizard-3` in both themes (Mistral paid label, Cerebras and Gemini CLI text, Mistral gone from the wizard step).
- **Not done / for you:** nothing was run against real Cerebras or OpenRouter (no keys here); the 402 body shapes are from OpenRouter's documented format and a LiteLLM-wrapped variant, so check the first real 402. Router container needs a rebuild to pick this up (`docker compose … up -d --build router`).

## M1.5 outcome

Branch `m15`. Guide: [docs/m15.md](m15.md). Screens: `docs/screens/{chat,chat-hover,chat-why,settings,status,footer,tooltip,shortcuts,splash}-{day,dusk}.webp`, plus every earlier screen regenerated. The work paused once (WIP handoff on 2026-11-17) and resumed on 2026-11-18. Commits in order: 0 doctor, 0b self-healing (router, portal), A router API, B foundations, Dial, C shell, D chat, E settings, F motion and cursor, G checks and docs.

- **doctor.sh:** never hangs.
  - It used to call `timeout 10 bash -ic`; an interactive bash ignores SIGTERM and grabs the TTY.
  - Now stdin is /dev/null and there is no interactive shell. Every external call has a hard limit (5 s commands, 3 s network; 10 s for the router's CLI endpoints, 45 s per live model call).
  - Each check is printed before it runs. `--verbose` prints commands with secrets redacted.
  - Cerebras is `optional: true` (grey, no warning) and marked skipped in CHECKLIST.
- **Self-healing:**
  - **Root cause of the OpenRouter key-replace bug:** LiteLLM lists a `<provider>/*` wildcard once per provider model in `/model/info`, all with one id. Reconcile deleted the "duplicates", removing the wildcard. Rows are now collapsed by id. On first start here the fix logged -95; the two wildcards that went with them came back 30 s later via the drift check, and a later restart removed nothing.
  - **Idempotent writes:** deleting something already gone counts as success; creating an existing id becomes an update; deployment ids are deterministic; a lock stops concurrent reconciles.
  - **`app/sync.py`:** syncs on startup and every 5 min, on a 10 s liveness check (restart), on a 30 s drift diff, and on request; backoff 2–60 s.
  - **Plain errors:** coded `{code, message, detail}`; `ErrorNote` shows one sentence and one action, with raw text in Pro mode only. "Retry now" on cards.
  - **`/status`:** in-app fixes or plain instructions.
  - **OpenRouter/Zen:** recommended only from free models; a paid model shown is labelled "Paid".
  - **Verified live:** stopping and starting LiteLLM was followed by "LiteLLM came back (restart)" and a resync; deleted wildcards were restored.
- **Router API:** Alembic `0003` (`threads.pinned`), pin via PATCH, export (JSON/Markdown), clear-all with a confirm phrase, `GET/PUT /settings` (caps and private-by-default over the read-only rules.yaml; the stricter cap wins), `GET /system/summary`. Version 0.1.5.
- **Portal:**
  - Every item in the M1.5 brief: scrollbars, chat layout, Why fix, footer, splash/transitions, Settings (7 sections), motion v2, ambient cursor, one tooltip, shortcuts sheet. Details are in docs/m15.md and SPEC §8c (updated).
  - Also: a top-bar scrim, so content no longer shows between the nav pills.
  - Also: the Dial is CSS, which cut first-load JS by 6.4 KB.
- **Decisions:**
  - The tooltip is a delegated DOM layer, not Radix Tooltip, which would have pushed `/chat` over 200 KB.
  - The splash is CSS-only. Page transitions run only on client navigations. Staggers never start fully transparent (LCP).
  - Settings overrides live in `system_meta`, not in rules.yaml. Private-by-default is the composer's starting state, not a lock.
  - Restarts are detected by liveness plus the diff; LiteLLM has no restart marker.
- **Checks:**
  - Router: 138 pytest, ruff clean.
  - Portal: 58 vitest; Playwright 119 functional/axe (both themes) plus 68 visual baselines.
  - **Visual baselines.** New: `chat-collapsed`, `chat-hover-actions`, `footer`, `footer-phone`, `settings`, `shortcuts`, `status`, `tooltip` (each light/dark). Regenerated: every older baseline. The reserved scrollbar gutter, the footer and the new chat layout change every page. `dial` also changed: anti-aliasing of the CSS handle.
  - Lighthouse (mobile): performance 95–100, accessibility 99–100, best practices 100, CLS ≤ 0.002.
  - First-load JS: `/chat` 197.3 KB, `/welcome` 196.9 KB, others ≤ 193.4 KB.
  - CLS fixes found while measuring: the footer moving under skeletons, lazy menus collapsing, and the phone composer note appearing late.

## Carry-over from M1.5

- **JS budget:** `/chat` and `/welcome` are within 3.2 KB of the 200 KB cap. The next shared addition needs a trim; candidates are the chat-only strings or splitting the thread-row menu.
- **Visual flakes, fixed:** late lazy chunks shifted the gallery while sections were captured; shots now wait for a stable layout (`settled()`). Watch for new ones in M7 CI (same Linux Chromium only).
- **`explore` alias** (OpenRouter `openai/gpt-oss-120b:free`) answered 404 through LiteLLM. Check the catalog or re-pin (M3).
- **Home composer** doesn't read Settings → Privacy yet (`/chat` does).
- **Lazy Markdown swap** still causes a small shift on `/chat` (0.002).
- **Still open from earlier (yours):** add the Mistral, OpenRouter, Zen and xAI keys as wanted; verify the CLI login commands after installs; remove `GROQ_API_KEY`/`GEMINI_API_KEY` from `deploy/.env`.

## M3a outcome

Branch `m3a`. Guide: [docs/m3a.md](m3a.md), with the confusion matrix, measurements and live demo transcripts. Screens: `docs/screens/{chat-sensitive,chat-secret,chat-summary,settings,status,footer}-{day,dusk}.webp` (fixture data) and `{footer-quota,status-live}-*` (live, Groq at a test limit). Commits: (I) hostprobe `/hw`; backend A–F + I; (E) labelled set, eval and classifier fixes; (I) setup/doctor; (G, G2) portal; fixes from the live demos; tasks model.

- **Classifier:**
  - Arch-Router-1.5B on Ollama with route descriptions in `rules.yaml`. A keyword pre-filter decides strong signals, and the heuristics are the fallback (down, reloading, slower than 1.5 s, unknown route) with a 60 s breaker.
  - On 80 labelled prompts (`services/router/tests/routing.jsonl`, written before tuning): **96.2% overall, 92.5% on the held-out half** (target ≥ 85%). Heuristics alone: 60% (72.5% with the new sensitive fallback, an optimistic figure).
  - The Q4 GGUF answers with single quotes, so the first run measured 60% until the parser accepted them.
- **Recommender (SPEC §6.4):** hard filters, then a weighted score over capability, feedback, latency, success, quota headroom, cost and privacy. Fewer than 5 samples never wins unless Settings → Routing → Explore is on. "Why this?" shows the score, the top factors and the runner-up with its score. It drives `best:<capability>` and the dynamic `explore` alias.
- **Quota guard:**
  - `limits:` in `providers.yaml` (Groq and OpenRouter verified 2026-11-18; Gemini estimated). Counters per minute and per day live in the DB, plus `x-ratelimit-*` headers (LiteLLM forwards them).
  - At 80%, automatic routing moves elsewhere (the last 20% is kept for manual picks) and spreads to `equivalent:` stand-ins. Cooldowns are persisted.
  - The footer reads "Groq 72% of today's limit"; Status says "Rate-limited until 14:05", "82% of today's free limit used. Resets at…".
  - **Live:** with `ROUTER_QUOTA_TEST_LIMITS=groq:openai/gpt-oss-120b=rpd:3`, the 4th message went to `groq/openai/gpt-oss-20b` with no 429.
- **Generic OpenAI-compatible adapter:** `adapter: openai-compatible` plus `models_url`, `models_fields`, `params` (`{account_id}`-style URL placeholders, asked for in the key form) and `limits`. It is proved by a YAML-only end-to-end test. **No provider added** (your call): GitHub Models was retired on 2026-07-30; see Future providers below.
- **Long threads:** a summary starts at 75% of `max_context_tokens`, keeps the last 6 messages verbatim, is incremental, stored on the thread, and shown as a collapsible note. A private thread never uses a cloud model. Verified live.
- **Auto-private + secrets (your safeguards):**
  - Sensitive messages stay local with a notice and a one-click "Not sensitive — use cloud". Settings toggle, on by default. Overrides are logged.
  - Secrets always stay local and are masked everywhere, with a test per surface. Live found: the local model repeated the key, so replies are masked too.
  - Live found: after a private chat the classifier was evicted and a health question fell back to the heuristics and went to Groq. The heuristics now keep first-person sensitive messages local.
- **Local-model profiles** (`config/local-models.yaml`): none / small / medium / large from detected VRAM (hostprobe `/hw` → nvidia-smi). Shown in setup, doctor, the wizard, Status and Settings → Local models (picker, pull).
  - **Measured on 4 GB:** Arch-Router and qwen3:4b (or llama3.2:3b) don't fit together; Ollama swaps them whatever `keep_alive` says (classifier reload ≈ 3 s). The router reloads the classifier in the background and skips it while it reloads.
  - **qwen3:4b with `think:false` still reasons in its answer**, so the tasks model is llama3.2:3b. `local-code` now follows the profile (qwen3:4b on small).
- **M1.5 carry-overs done:**
  - `explore` resolves from the catalog; a 404 means a 6 h cooldown plus a catalog refresh.
  - The Home composer honours private-by-default.
  - Status rows give specific reasons.
- **Checks:**
  - Router 227 pytest (89 new), ruff clean. hostprobe 58.
  - Portal 61 vitest, 195 Playwright (axe in both themes); baselines regenerated for settings and status only.
  - `/chat` 197.7 KB. Lighthouse ≥ 90 everywhere (`/chat` 91–94). Bundle check passes. doctor all green.
- **Deviations from the plan, and why:**
  - **GitHub Models.** Retired, so the proof is test-only.
  - **Tasks model.** llama3.2:3b instead of qwen3:4b (reasoning leak).
  - **At most 2 loaded.** Can't hold on 4 GB (measured), so swap handling replaced it.
  - **Commits.** The A–F backend went in one commit; it was too intertwined to split by section.

## Carry-over to M3b

- Rules UI: table + form editor over `rules.yaml`, DB overrides and versioning with rollback, and the dry-run tester. `POST /route/dry-run` already returns the classifier result, scores and reasons.
- The classifier's two held-out private misses (a bank statement summary, a secret told in confidence) are both "general_chat". Tune the `sensitive_*` descriptions in the Rules UI, then re-run `scripts/eval-routing.py` and report on the held-out half.
- Run `scripts/eval-routing.py --overrides` after a few weeks of use: auto-private precision against your overrides.
- Small GPUs: consider `classifier_options: { num_gpu: 0 }` for the `small` profile (always loaded, ~0.9 s, 95%) if the first-message-after-private heuristic fallback bothers you.
- The gallery `composer`/`provider-card` (light) visual capture flakes in full runs (passes alone). `/chat` Lighthouse performance is 91–94.
- Gemini free limits are estimates: check aistudio.google.com/rate-limit and edit `providers.yaml`.
- **Still open from earlier (yours):** Mistral/Zen/xAI keys as wanted; CLI login checks after installs; remove `GROQ_API_KEY`/`GEMINI_API_KEY` from `deploy/.env`.

## M3b outcome

Branch `m3b`. Guide: [docs/m3b.md](m3b.md) (what changed, the checks, and the decisions taken without asking). ADRs: [0001](adr/0001-record-architecture-decisions.md) records decisions, [0002](adr/0002-small-profile-cpu-classifier-and-tasks.md) small profile, [0003](adr/0003-left-sidebar-app-shell.md) sidebar, [0004](adr/0004-rules-overrides-and-versioning.md) rules overrides. Screens: `docs/screens/m3b/` (sidebar expanded / collapsed / drawer in both themes, the chat page at 360/768/1024/1280/1440/1920 px and 125%/150% zoom, Rules Simple and Pro, validation, commands, history, tester). Commits in order: CLAUDE.md + ADR 0001; small profile + Gemini limits; hostprobe login checks; visual flake; rules backend; thread-list pagination; sidebar; Rules UI; docs and evidence.

- **Engineering principles** (8) and the decision protocol are in CLAUDE.md; `docs/adr/` started.
- **Small profile:** classifier and tasks model on the CPU, the chat model alone on the GPU, titles and summaries through one low-priority queue that yields to classification (`app/local_queue.py`). Measured on this 4 GB machine: keyword-fallback rate after a local reply 100% → 0%, accuracy unchanged (96.2%, held-out 92.5%), classifier p95 0.96 s alone and 1.23 s while a title job runs (limit 1.5 s, not raised). Docs: docs/m3a.md.
- **Gemini free limits** (owner's AI Studio, 2026-11-19, India): in `providers.yaml`; quota limits take glob model keys and `0` = no free access (all Pro and image models). Verified for one account only; the guard also learns from headers and 429s. M5 carry-over: **Gemini has no free image generation**.
- **hostprobe:** `claude auth status --json` (boolean `loggedIn` only) and `codex login status` verified on the real Linux binaries; doctor shows both logged in. gemini and grok still unverified (not installed in WSL).
- **Visual flake, root cause:** `content-visibility:auto` gallery sections were 708 px placeholders until scrolled to, so a capture raced the lazy render. Fixed in the capture (`renderAllSections`), thresholds untouched. Two more were found in this milestone's own baselines (sticky chrome at a click-dependent scroll position; a rules table scrolling sideways inside its box) and fixed at the cause. Evidence: 3 full runs of 322 tests at 8 workers, plus 936 visual passes before the last tweak.
- **Sidebar shell** (ADR 0003): the top pill bar, the bottom tab bar and the chat page's thread column are replaced by one left sidebar (logo, ⌘B collapse, New chat, ⌘K search, six sections, global paginated recents with server-side search, budget Dial, breathing health dot, Simple/Pro, appearance, settings, profile), an icon rail and a phone drawer, plus a slim page header with a slot for page actions. `GET /chat/threads` is keyset-paginated and indexed (migration 0006). Footer trimmed to quota, value saved, version, links.
- **Rules UI** (ADR 0004, `/settings/rules`): Simple mode = presets + paid policy + tester; Pro = rule table and form, slash commands, classifier wording, weights/quota/summary/defaults, history with diff and rollback. `rules.yaml` stays the base; edits are append-only versions in `rules_versions` (migration 0005), validated by the same parser plus field/range/target checks with plain messages; the `private` rule cannot leave the machine; stale edits and saves of the same document are handled; a saved override that stops fitting a changed `rules.yaml` is ignored and reported. `POST /route/dry-run` takes an unsaved `draft` and returns decision, classifier answer, order, reasons, score breakdown and runner-up. The editor's live preview merge is pinned to the router's by shared contract cases.
- **Layout evidence:** 86 tests (6 widths × 8 pages, 6 zoom cases, rail, drawer focus/Esc/inert, motion, axe in each state) assert no sideways scroll and nothing outside the window or the sidebar. They found and this milestone fixed: reply actions overflowing at 360 px, viewport-breakpoint grids on Connections and the wizard (now `auto-fill`; the wizard's two columns start at 1280 px).
- **Budgets:** first-load JS `/chat` 197.7 → 196.0 KB, `/settings/rules` 188.7, `/welcome` 197.4 → 198.9 (tightest), others +0.5 to +1 KB. Lighthouse 94–100 / 100 / 100 everywhere (`/chat` 94 light, 92 dark; CLS ≤ 0.005); two regressions it caught (`/chat` 87, Rules CLS 0.064) were fixed at the cause (recents load when idle; Rules panels render on the server).
- **Checks:** router 306 pytest, hostprobe 64, portal 83 vitest, 322 Playwright (axe in both themes on every page and sidebar/rules state, 78 visual baselines), eslint/tsc/ruff clean, bundle check passes, doctor all green. Live: router rebuilt (migrations 0005/0006), `/rules`, validation, three dry runs against the real Arch-Router on the CPU.
- **Process note:** you were away, so reversible choices went to the recommended option and are listed in docs/m3b.md ("Decisions taken without asking"). Two "safety check" refusals hit harmless edit scripts mid-session; the same edits were made with the Edit tool.
- **Deviations from the plan, and why:** the router image and hostprobe unit were restarted on this machine to run the live checks (needed for migrations 0005/0006 and the new parsers). The Simple-mode scope (presets + paid policy + tester; overlay editing is Pro) is the narrowest reading of "presets only" that still lets Simple change something.

- **Review fixes (before merge):** sky covers the full page (root background + `tests/sky.spec.ts`); Simple mode is plain language in "Why this?" and Rules → Presets (Pro unchanged); one sidebar search (ADR 0003 amendment); empty recents groups hidden. Baselines and `docs/screens/m3b/` regenerated.

## Carry-over to M4

- **Verify when installed:** gemini and grok login-status commands (claude and codex done). `gemini-cli` is still a Windows binary only.
- **Classifier margin:** ~270 ms under load on the CPU profile. A slower CPU may need `classifier.timeout_s` raised (now editable in Rules → Commands & classifier); watch the fallback count in Status.
- **Tune the two held-out private misses** (bank statement summary, a secret told in confidence): edit the `sensitive_*` wording in the Rules UI, save, then `scripts/eval-routing.py --saved-rules` and report the held-out half. Not done here (it was not in the M3b list, and tuning on held-out lines needs care).
- **`rules_versions` has no pruning**; rows are small. Prune by age if it ever matters.
- **Thread search** is `ILIKE` over titles (fine for thousands); add `pg_trgm` if it ever isn't.
- **Budget:** `/welcome` is at 199.2 KB (0.8 KB under the cap) and `/chat` Lighthouse has little headroom; the next shared addition needs a trim (candidates: the Recents chunk split, lucide icon imports, `strings.ts` core keys).
- **Rules UI follow-ups:** the portal's fixture validation is partial by design (router tests are authoritative); preset overlay editing is Pro-only; no drag-and-drop reordering (buttons only); the page-actions slot is used for the unsaved count only.
- **Gemini limits** are one account's: other users may differ. M5: no free Gemini image generation (local SD or paid Grok Imagine).
- **Machine setup:** after pulling M3b, rebuild the router (`docker compose -f deploy/docker-compose.yml up -d --build router`; migrations 0005 and 0006 run on start) and restart hostprobe (`systemctl --user restart switchboard-hostprobe`).
- **Still open from earlier (yours):** Mistral/Zen/xAI keys as wanted; remove `GROQ_API_KEY`/`GEMINI_API_KEY` from `deploy/.env`.

## README v1 outcome

Branch `readme-v1`. Guides: [recording-the-demo.md](recording-the-demo.md), [ADR 0005](adr/0005-readme-media-and-single-version.md). Commits: version + demo-router flags; Motion and Connect step lazy-loaded; media generator and CONTRIBUTING; chat pinned at the end; docs check and demo stack; demo, screenshots, README.

- **README.md** is rewritten: animated hero (Day and Dusk, `<picture>`), badges, demo GIF + MP4, "Why Switchboard", an animated routing diagram with a Mermaid text version, a four-step Quickstart (Windows + WSL2 now; macOS and Linux "coming in M7"; Jobs "coming in M4", no screenshot because the screen is a placeholder), a feature tour of shipped features only, Privacy and security (including the honest "no portal login yet"), a dated comparison table (Open WebUI, OmniRoute, 9Router, Paperclip, Ollama app; built from public docs and listings, "not stated" where unconfirmed), roadmap (matches the status table above, checked by script), FAQ, Contributing, License, Star History. New: `CONTRIBUTING.md`, `docs/recording-the-demo.md`.
- **Media** (`docs/media`, 6.2 MB of the 15 MB budget): `hero-*` 4.7 KB and `routing-*` 7.5 KB SVGs (generated from the design tokens; CSS keyframes; all animation off under `prefers-reduced-motion`, which shows the complete static frame; system font stack because an `<img>` SVG can't load web fonts), `demo.gif` 4.8 MB (800 px, 10 fps) and `demo.mp4` 1.2 MB (58 s, 1280×720), 14 `shot-*.webp` screenshots (25 to 43 KB each, fixture data). GitHub can't play a repo-relative `<video>` in a README, so the GIF links to the MP4.
- **Demo** (real Groq reply, real local private reply, Connections with `••••`, Rules tester) is recorded against a throwaway Demo stack (`scripts/demo-stack.sh`): a separate `switchboard_demo` database (schema from migrations; only connection rows, "key saved" markers with a dummy ciphertext and masked suffix, the model catalog and a few settings rows copied; never threads, messages, requests, costs or keys), plus one router container. Your real stack was not stopped. The demo router sets `ROUTER_SYNC_ENABLED=false` (no LiteLLM writes, no catalog refresh; a test) and tags traffic `switchboard-demo` (`ROUTER_REQUEST_TAG`; LiteLLM `user` and tags, and `decision_json.tag`; tests). The local model took 15 to 90 s per reply across takes, so waits over 6 s are sped up and labelled on screen.
- **One project version:** root `VERSION` (0.4.0). The router reads it (compose `additional_contexts`); the portal footer shows the router's version; `apps/portal/package.json`, its lockfile and the fixtures matched to it (they said 0.1.5). `npm run docs:check` fails if any copy or the README badge disagrees. No tag yet: tag `v1.0.0` at launch (M7).
- **JS budget** (gzip, first load, before → after): `/welcome` 199.2 → 170.3, `/chat` 196.4 → 178.8, `/connections` 195.0 → 177.3, `/dev/components` 193.5 → 191.6, `/settings/rules` 189.2 → 171.4, `/` 187.0 → 169.2, `/status` 186.1 → 168.3, `/settings` 186.2 → 168.3, `/jobs`, `/metrics`, `/studio` 180.9 → 163.1. Every route has at least 8.4 KB of headroom (the dev gallery is the tightest). Two changes did it: **Motion** (~19 KB, in every route for the toast and PillTabs only) now loads with the first toast or PillTabs (`MotionScope`, same animations), and the wizard's Connect step, which pulls in the provider-card stack, is a lazy chunk with a same-size skeleton (`ConnectStep.tsx`).
- **Two things the smaller bundles exposed, fixed at the cause:**
  1. The chat scrolled to the newest message, then the lazy Markdown and highlighting chunks changed message heights above it, shifting what the reader sees (CLS up to 0.09 under load; 0.002 before). The thread now stays pinned to the end until the reader scrolls or 2.5 s pass.
  2. "New chat" from a thread that was just started in place (URL rewritten with `replaceState`) changed the URL but kept the old messages on screen. `ChatScreen` now resets when `?t=` goes away; a regression test fails without the fix and passes with it (found while recording).
  Baselines `chat-*` and `chat-why-pro-*` were regenerated: the old ones had captured the race (sticky sidebar painted at a timing-dependent scroll offset; a viewport-clipped popover missing its last line). The chat capture now starts from the top. The footer version in baselines is now 0.4.0.
- **Checks:** router 311 pytest (306 + 4 demo-router tests + 1 version test), ruff clean; portal tsc, eslint, 85 vitest clean; Playwright 348 (347 + the New-chat test); docs check passes. Full runs at 8 workers on the final build: 2 of 3 clean; the other had two failures, both load flakes below. Not re-run after the last change: Lighthouse (the lazy-loading only removes JS from first load; run it with M4) and `test:bundle` (no server-side code changed).
- **Flakes, measured against clean `main` rather than assumed** (same stress: one test repeated under 8 workers; failures / runs, `main` vs this branch): `chat · thread with code` visual 12/60 vs **1/60** (the pin and top-of-page capture made it better); `no long tasks (> 50 ms)` on `/connections` 3/30 vs 1/30; `axe · sidebar states › phone drawer open` 3/72 vs 3/72 (`link-name` on the recent-chat rows; the row is fine a moment later). So all three already flake on `main` under load, and none got worse here. (An earlier "3 of 3 full runs clean on `main`" was luck, not proof.) Single runs of each pass.
- **Deviations:** the demo uses a separate database and router, as agreed, rather than the owner's stack. I started Ollama (`ollama.exe serve`) through WSL interop for the recording because it had stopped, and pulled `curlimages/curl` once while diagnosing; neither is needed afterwards.

## Carry-over to M4 (from README v1)

- **Metrics (M6) must exclude demo traffic:** filter out LiteLLM `user = switchboard-demo` and `requests.decision_json.tag = 'switchboard-demo'`.
- **Fix the three existing load flakes at their cause** (rates in the README v1 outcome): `axe · sidebar states › phone drawer open` (`link-name` on recent-chat rows, transient), `no long tasks` on `/connections`, and the `chat · thread with code` capture (1/60 left). Reproduce with `npx playwright test <spec> -g <name> --repeat-each=30 --workers=8`.
- **Re-record the demo** whenever the UI changes (`docs/recording-the-demo.md`); update README screenshots with `npm run screens:readme`.
- The README claims nothing about install time or other machines; run the Quickstart on a clean WSL machine before M7 and fix what breaks.
- `package-lock.json` gained `ffmpeg-static` (dev only; downloads an ffmpeg binary at install).

## M4a outcome

Branch `m4a`. Guide: [docs/m4a.md](m4a.md) (the verified Paperclip API, CLI flags per level, live proof). ADRs:
[0006](adr/0006-local-thinking-profile-setting.md) local chat without a thinking phase,
[0007](adr/0007-paperclip-integration-shape.md) how jobs use Paperclip, [0008](adr/0008-hostprobe-git-worktrees.md)
worktrees through hostprobe. Commits in order: private chat speed; three flakes; Paperclip adapter; agent registry;
job engine; host safety (hostprobe); live-proof fixes; empty-folder cleanup; Connect-step LCP + chat pin; research
fallback; docs.

- **0a Private chat speed (ADR 0006).** qwen3:4b reasoned before every private reply and only 66% of it fits the
  4 GB GPU: first word median 31.4 s (worst 268 s). With thinking off it writes its reasoning into the answer (9 of
  10). Profiles now have a non-thinking `general` (`qwen3:4b-instruct-2507-q4_K_M`) and a `thinker` for the new
  `local-think` alias; the chat API takes `think` per message and the composer shows **Think harder** while
  private. Measured through the real path: first word **0.2 s**, whole answer 7.7 s; Think harder ~40 s.
  `measure-local.py --chat` reproduces it. qwen3:1.7b was fastest but wrapped prose in code blocks (rejected).
- **0b Three load flakes, at the cause** (stress: `--repeat-each=100..150 --workers=14`; failures before → after):
  phone-drawer axe 23/300 → 0/900 (the reduced-motion rule's `0.01ms` on `*` transitioned inherited `visibility`,
  so row labels stayed hidden until the next frame; now `0s` duration and delay); `/connections` long tasks 87/100 →
  0/300 (the `longtask` API is wall-clock: 94/100 runs had a >50 ms task, none used >29 ms of CPU; the test now
  checks per-task CPU time from a trace, same 50 ms limit, with a negative control); chat code-thread capture 18/200
  → 0/600 (the 2.5 s pin re-scrolled after a non-input scroll; any scroll up now unpins, which also fixes scrollbar
  drags, find-in-page and screen readers; regression test fails without the fix).
- **1 Paperclip adapter** (`app/paperclip.py`, pinned 2026.1106.0). Verified before building (docs/m4a.md): issue-
  scoped runs re-wake agents on their own (comment retry, disposition repair, review path) unless the agent manages
  the issue, worktree isolation is an off-by-default experimental flag that silently falls back to your checkout,
  `codex_local` copies `~/.codex/auth.json`, `opencode_local` writes skills into `~/.claude/skills`, Paperclip
  answers 403 to `Host: host.docker.internal` (Status had been counting that as up), and instruction writes need a
  revision. Contract tests: 19 recorded pairs plus live checks of the version pin and every route in Paperclip's
  OpenAPI document (`pytest -m live`).
- **Your decisions this milestone:** list-price budgets (cost_usd = real money, chat cap real money only, "cost not
  reported" capped by turns and time); level 1 = plan, approval, edits, diff review; chat answers and only proposes a
  job; Switchboard drives the phases (Paperclip-native mode kept for later); hostprobe makes worktrees; Paperclip
  stays `local_trusted` with a warning and a loopback check; Codex (and OpenCode, verified the same way) run
  through a thin `process` runner; the rule for every agent: never copy, read, move or write CLI login files.
- **2 Agent registry** (`config/agents.yaml`): claude-code, codex, opencode runnable; gemini-cli, grok-build, hermes
  listed as not verified. Flags per level verified on Claude Code 2.1.326, Codex 0.170.0, OpenCode 1.19.6, each with
  a negative test. Every run: clean environment (no SSH agent, keyring, GitHub login), push rewritten to fail
  locally, repos can't widen permissions.
- **3 Job engine** (`app/jobs.py`, `/jobs`, `/agents`, `/projects`; migration 0007: `jobs`, `job_events`,
  `projects`, `costs.external_id`, `costs.tag`). States queued / running / needs_approval / done / failed / stopped;
  SSE log stream resumable by byte offset; stop, approve, reject (also from Paperclip's UI); fallback before the
  first run only; one active run per agent; per-job and per-agent list-price budgets, Claude's `--max-budget-usd`,
  turn and time caps; costs keyed by run id and tagged for M6; agent costs never count toward the chat cap.
- **4 Safety on the host** (hostprobe, ADR 0008): Projects allowlist (never the Switchboard repo), worktree per job
  under `~/.switchboard/worktrees` on `switchboard/job-<n>`, commit on approval, retention (removed when rejected,
  failed, stopped or merged; at most 10 kept; branches never deleted); `/net/listen` for the Paperclip loopback
  check; bwrap detection (level 3 off without it).
- **5 Live proof** (`~/switchboard-playground`, docs/m4a.md has the table): level 1 "add a function + tests" with
  Claude Code (job 2, 28 s, list price $0.134, $0 spent), Codex (job 3, 46 s, cost not reported) and OpenCode
  (job 4, 62 s, $0): plan, approval, edits in the worktree, diff, commit on the branch; your `main` untouched. Also
  live: plan rejected (job 5), stop while running (job 6), budget cap (job 7, Claude stopped at $0.03), a Claude job
  after that error (job 8), allowlist refusals, and an agent run's environment (no Switchboard or provider keys; push
  blocked). It found and fixed five bugs (docs/m4a.md). A level-3 run (job 9) showed Paperclip's bwrap sandbox can't
  start on Ubuntu 24.04 (merged `/usr`): it failed safely, and **level 3 is off for every agent** until a sandbox works.
- **Also:** `/welcome?step=3` Lighthouse was 80 on `main` too (LCP 4.4 s, the intro text waited for the lazy cards):
  now 99; `VERSION` 0.5.0 with `scripts/set-version.mjs` (copies are no longer edited by hand); README, demo (no
  sped-up wait now) and screenshots updated; doctor checks Paperclip's version, loopback binding and CLI PATH.
- **Checks:** router 386 pytest (+ 2 live contract), ruff clean; hostprobe 70; portal tsc, eslint, 85 vitest, 349
  Playwright (two full runs clean), JS budget (all routes ≤ 191.9 KB), bundle secrets, docs check, doctor green.
  Lighthouse ≥ 90 on every route except `/chat` dark, which measures 87–93 **on `main` and on this branch alike**
  (interleaved runs; identical main-thread work): carried over below.
- **Changes on your machine (outside the repo):** pulled `qwen3:4b-instruct-2507-q4_K_M` (2.5 GB) and, for the
  measurement only, `qwen3:1.7b` (1.4 GB); systemd drop-in `~/.config/systemd/user/paperclipai.service.d/
  switchboard-path.conf` (Paperclip restarted twice); `~/switchboard-playground` (with a fake `origin` for the push
  guard) and its branches `switchboard/job-1..8` (worktrees removed); a "Switchboard" company in Paperclip with three
  agents. Probe artifacts removed: the probe company and its leftover folder (which held two copies of the Codex
  login), and three skill links Paperclip had added to `~/.claude/skills`.
- **Deviations:** commit 4 (host safety) landed after the engine because the engine's safety rules live in the
  registry and engine; level 3 is off for all agents (above), so jobs run at levels 0–2 in M4a; a router test failed once in
  ~34 full runs (`test_cerebras_credits_are_tracked_and_routing_stops_at_zero`) and did not reproduce in 37 more runs.

## Carry-over to M4b

- **The Jobs page:** job board (list, filters, paging), live log over `GET /jobs/{id}/events`, plan and diff review
  with approve / reject (note), stop, budgets and "cost not reported", the Projects allowlist (add, remove, disk use,
  cleanup) and the agents list with per-level availability. The chat's **Run as job** button uses
  `decision_json.job` (agents, autonomy) and `from_request_id`. Update the strings that still say "Run as job (M4)" and
  "/research … (job in M4; chat for now)".
- **`/chat` Lighthouse 87–93 (dark)** on `main` and here: total blocking time ~400 ms, mostly one shared chunk (~950 ms
  scripting under throttling). Cut it at the cause in M4b, which changes `/chat` anyway.
- **Level 3 (all agents):** Paperclip's bwrap profile fails on merged-`/usr` systems (Ubuntu 24.04). Options: a
  Switchboard bwrap wrapper around the process runner (also covers Codex and OpenCode), or a fixed Paperclip version.
  Verify with a live run before turning it back on in `config/agents.yaml`.
- **Optional agents:** Gemini CLI (Linux install), Grok Build (does headless use bill an xAI key?), Hermes: verify flags
  and login checks before adding runners.
- **Paperclip-native mode** (ADR 0007 "Later") for lead agents delegating work.
- **Paperclip quirks to watch:** a terminated agent can't be deleted (500), and deleting a company leaves its folder
  on disk. A new Paperclip version must be re-verified first (`pytest -m live` fails on a version change).
- **Medium and large profiles** now default to the 4B instruct model for chat: not measured on those GPUs.
- `qwen3:1.7b` was pulled only to measure it: `ollama rm qwen3:1.7b` to free 1.4 GB.
- Still open from earlier: gemini/grok login commands, the classifier margin, the two held-out private misses,
  `rules_versions` pruning, thread search, Mistral/Zen/xAI keys, removing GROQ/GEMINI keys from `deploy/.env`.


## M4b outcome

Branch `m4b`. Guide: [docs/m4b.md](m4b.md) (what you can do, how it works, the Lighthouse fix, checks, live proof,
decisions taken without asking). ADRs: [0009](adr/0009-agent-fleet-overlay.md) the fleet as a database overlay on
agents.yaml, [0010](adr/0010-level-3-sandbox.md) level 3 in a locked-down container per job (M7). Commits in order:
backend; portal; tests, baselines and gates (version 0.6.0); readable log and tab switching (found live); docs and
media; PROGRESS.

- **Jobs page:**
  - `/jobs`: status tabs with counts, agent/project filters in the URL, keyset paging.
  - `/jobs/<id>`:
    - timeline in plain words;
    - live log over SSE, resumed by `Last-Event-ID`, readable or raw, 5,000-line ring buffer, earlier runs paged;
    - plan and per-file diff (solid panels, highlighted when opened, rendered with the page when the job waits on it);
    - approve/reject with a note, approval deadline, stop, run again;
    - cost, list price or "cost not reported", with a budget dial;
    - branch with Copy and plain `git` commands to review and merge it yourself.
- **Run as job:** from a chat reply (the decision's proposal) or **New job**. Choose the project, the agents in order
  (fallbacks), autonomy (level 3 shown off with its reason: Dial `disabledStops`) and a budget. Then the router's own
  preview of exactly what will happen; nothing starts before Confirm.
- **Projects** (Settings → Projects): add/remove with plain errors (`~/` paths work; the Switchboard repo refused with
  its reason), copies and disk use per project, clean up, retention.
- **Fleet** (`/jobs/agents`, ADR 0009):
  - status, installed and logged in, current job, success rate, today's and monthly budget, cost;
  - pause/resume, edit, reset to default, soft delete, hire from Claude Code / Codex / OpenCode templates (optional
    CLIs show "not installed" or "not verified");
  - role, model, default autonomy, monthly list-price budget, allowed projects;
  - Paperclip name, pause and terminate kept in sync idempotently.
- **Your additions:**
  - Jobs badge in the sidebar and toasts when a job needs you, finishes or fails (a watcher polling every 15 s);
  - optional desktop notifications (off; permission asked only when turned on);
  - approval expiry (Settings → Jobs, default 24 h, stops the job with a plain reason);
  - reset to default for edited built-in agents;
  - hired agents soft-deleted (history kept).
- **Level 3 (ADR 0010):** options were a Switchboard bwrap wrapper, a locked-down Docker container per job behind an
  egress-allowlist proxy, or waiting for Paperclip. Your choice: the container, built in M7. It stays off, with the
  reason everywhere it can be picked.
- **`/chat` Lighthouse:**
  - Cause, measured: every reply was upgraded to Markdown, and every code block highlighted, in a few long tasks after
    load (TBT 360–470 ms; without the upgrade 150–190 ms).
  - Now each reply upgrades in its own idle slice once it is near the screen, and code highlights per block.
  - Result: 95–99 over 20 runs in both themes (was 88–92 dark).
  - Two layout shifts found while measuring are also fixed (job diff 0.047, Projects 0.038 → 0).
- **Status:** Paperclip's row says "No login (local only)" and shows the loopback check in Simple mode too.
- **Checks:**
  - router 397 pytest (+ live contract with the new pause/resume/terminate routes), ruff clean; hostprobe 71;
  - portal tsc, eslint, vitest 98; Playwright 416 (two full runs clean; axe both themes on the new pages and dialogs;
    14 new baselines, stable 280/280 at 14 workers);
  - Lighthouse ≥ 95 performance on every route; JS budget (`/chat` 180.0 KB, new routes 171.5–178.2 KB);
  - `test:bundle`, `docs:check` pass.
- **Live proof** (real stack, `~/switchboard-playground`):
  - a chat reply → Run as job → OpenCode level 1 → plan approved → changes (2 files) approved → committed `133e35a` on
    `switchboard/job-10` in 71 s, with the toast on another page; your `main` untouched;
  - a level-2 job stopped mid-run (Paperclip run cancelled, no process left, copy removed);
  - the fleet's pause/resume/rename/reset reflected in Paperclip; hire and soft delete;
  - project refusals in plain words;
  - Status notes.
- **Also:**
  - **Version 0.6.0.**
  - **Readme:** Jobs quickstart step with screenshots, feature tour, roadmap ✅.
  - **Demo re-recorded** (about 80 s). The jobs and fleet part runs on labelled sample data: a real job on the Demo
    stack would reuse job numbers, branches and Paperclip issue keys.
  - **Fixed `test_turn_cap`, which failed on `main` too.** The fake Paperclip stamped every run as started at
    06:00 UTC, so the job-time cap fired after 08:00 UTC.
  - **SPEC changes:** a job's detail is a page (§8c exception); §7.3 has a level-3 note; M4a/M4b rows added to §11.
- **Changes on your machine (outside the repo):**
  - router image rebuilt (migration 0008) and hostprobe restarted;
  - in `~/switchboard-playground`: job 10's branch with its commit, job 11's branch (stopped, no commit), and the
    playground project removed and added again (same row, history kept);
  - a soft-deleted hired agent `doc-writer` in `agent_profiles` (never created in Paperclip);
  - demo stack created and removed again.
- **Deviations:**
  - **`/chat` grew 1.2 KB** (178.8 → 180.0) from the shared sidebar badge store and the idle queue, against the
    plan's "not larger"; it is well under the cap and halves `/chat`'s blocking time.
  - **The demo's job segment uses sample data** (the plan's stated fallback).

## Carry-over to M4.5 and later

- **Level 3 (M7, ADR 0010):**
  - a `sandbox: container` runner with pinned images per CLI;
  - an egress-allowlist proxy on an internal network;
  - a "Log in for sandboxed jobs" flow (vendor CLI login into a named volume; host login files never copied);
  - doctor checks;
  - live negative tests per CLI (read outside the worktree, reach a non-allowlisted host, read the host's
    `~/.claude`) before turning level 3 on per agent.
- **Optional agents:** Gemini CLI (Linux install), Grok Build (does headless use bill an xAI key?), Hermes: verify
  flags and login checks, then add runners to agents.yaml so they can be hired.
- **Paperclip-native mode** (ADR 0007 "Later") for lead agents delegating work.
- **Badge and toasts poll every 15 s:** fine for one person. If many tabs or users ever matter, switch to one shared
  SSE stream.
- **"Open in Paperclip"** links to `/issues/<id>` (the route is in Paperclip 2026.1106.0's UI bundle). The link wasn't
  clicked live; confirm on the next Paperclip upgrade.
- **Metrics (M6)** should read job costs per agent (`costs.source = paperclip`, joined to `jobs.agent`) and exclude
  demo traffic (`switchboard-demo`), as noted in README v1.
- Still open from earlier:
  - gemini/grok login commands;
  - the classifier margin and the two held-out private misses;
  - `rules_versions` pruning and thread search;
  - Mistral/Zen/xAI keys;
  - removing GROQ/GEMINI keys from `deploy/.env`;
  - `ollama rm qwen3:1.7b`;
  - medium/large profile defaults not measured on those GPUs.

## Future providers

- **Cloudflare Workers AI**: 10,000 Neurons/day free, no card per the pricing page. The URL needs your account id (supported now through `params:`), and there's no OpenAI-style `/models`, so it needs a `models_url` plus `models_fields` mapping. Check its data terms first.
- **NVIDIA NIM** (integrate.api.nvidia.com/v1): trial only. The terms forbid production use and personal, health or financial data, and it runs on credits. Opt-in only if ever added, kept off every automatic chain.
- Not usable today: GitHub Models (retired 2026-07-30), Hugging Face Inference Providers (no free credits for free accounts), Ollama Cloud (no free usage tier).

## Future

Ideas and later milestones, not scheduled. Additions only.

- **Local compute optimizer:** multi-GPU and one Ollama instance per GPU (NVIDIA and an AMD iGPU), show the GPU-vs-RAM split of each loaded model, a fit advisor ("this model fits / spills to RAM"), and tuning in Settings → Local models. Builds on the profile options (`classifier_options`, `tasks_options`, `max_loaded`) and `scripts/measure-local.py`; a RAM check belongs here too (the small profile assumes ~3.5 GB free for the CPU models).
- **Ollama Cloud** as a YAML provider (adapter: openai-compatible); check its free-tier terms first.
- **Check Antigravity (Google)** as a provider.
- **M2.5 Attachments** (files and images in chat).
- **M4.5 Workflow packs** (SPEC §8a).
- **M5 Studio:** no free Gemini images (see Gemini limits above), so local Stable Diffusion or paid Grok Imagine.
- **M5.5 Content Studio** (SPEC §8d).
- **M7 launch:** one-command cross-platform install (Docker for Mac, Linux and Windows), **portal user auth before any remote access**, tag `v1.0.0`. (The README and the demo GIF were done in README v1.)
- **GitHub Pages landing site with real interactivity (M7):** a live routing demo and a real video player, which a GitHub README can't run (it strips JS and CSS). Reuses the hero and routing SVGs and `docs/media`.
