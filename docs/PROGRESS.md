# Switchboard — Progress & Decisions Log

> Single source of project memory. Update at the end of every milestone (Claude Code: append, never rewrite history).
> Read this + SPEC.md at the start of any new chat or session.

## Status

| Milestone | Status | Branch / PR | Model used | Notes |
|---|---|---|---|---|
| M0 Infra | ✅ Merged | m0 / #1 | Opus 5.5, medium | doctor.sh green; fast + local verified |
| M0.5 Design system | ✅ Merged | m05 / #2 | Sonnet 5.5, medium | All 4 approved changes delivered; see M0.5 outcome |
| M1 Connections + wizard | 🔨 Split into M1a + M1b | — | Sonnet 5.5, medium | Done when M1b merges; carry-over items listed below |
| M1a Router backend | ✅ Merged | m1a / #4 | Opus 5.5 | Split from M1; see M1a outcome |
| M1b Connections UI + wizard | 🔎 In review | m1b | Sonnet 5.5 | Install/login flows, wizard, chips; see M1b outcome. Item 7 (verify CLI login commands) waits on your installs |
| M2 Chat + Router | ⏳ | — | Opus 5.5, high | |
| M3 Rules UI + classifier | ⏳ | — | Opus 5.5, high | |
| M4 Jobs via Paperclip | ⏳ | — | Opus 5.5, high | |
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
