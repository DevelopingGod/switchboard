# M1b — Connections UI, onboarding wizard, quick-start chips

The UI half of M1 on top of the M1a Router API: a real Connections screen (keys, tagged model badges, CLI install and login), the first-run wizard (SPEC §8b), Home quick-start chips, and the install endpoints in hostprobe.

```
 browser ──▶ Next.js server (127.0.0.1:3000) ──▶ Router API (127.0.0.1:8100) ──▶ LiteLLM / providers
              │  server components: reads         │
              │  server actions: writes           └──▶ hostprobe (WSL, 127.0.0.1:8101): detect, install
              │  /api/install/[job]/events: SSE log
              └─ ROUTER_ADMIN_TOKEN lives here only (apps/portal/.env.local); the browser never sees it
```

## Run it

```bash
scripts/setup-wsl.sh            # also writes apps/portal/.env.local (ROUTER_URL, ROUTER_ADMIN_TOKEN) if missing
cd apps/portal && npm run dev   # binds 127.0.0.1 only (-H 127.0.0.1), http://127.0.0.1:3000
scripts/doctor.sh               # new "Portal" section: env file matches, port 3000 not on 0.0.0.0
```

Use the **Linux** Node (nvm) for every `npm`/`npx` command. On this machine the shell PATH can resolve `npm` to the Windows install under `/mnt/d/NodeJS`; run `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"` first. Do not run `npm install` with the Windows npm: it rewrites `node_modules` and can strip execute bits.

First run sends `/` to `/welcome` until a wizard record exists (finish it or **Skip for now**). `/welcome?step=1…5` deep-links a step.

## The portal ↔ router boundary

- Only `src/lib/server/router.ts` knows `ROUTER_URL` and `ROUTER_ADMIN_TOKEN`. It starts with `import "server-only"`, so importing it from client code fails the build.
- Reads happen in server components. Writes are server actions (`app/connections/actions.ts`, `app/welcome/actions.ts`); each validates its input again because actions are reachable by direct POST. The install log is a route handler that passes SSE through and answers only loopback `Host` headers and same-origin requests.
- `npm run test:bundle` builds with a sentinel token, then greps `.next/static` and the prerendered HTML/RSC for the sentinel and for the variable's name, fetches every screen from a running server and checks the bodies, checks that no `"use client"` file imports `@/lib/server/*`, and checks the 403s above. It fails if any of that leaks. (Verified by planting the sentinel in a static file: it failed.)
- **The portal has no user login yet.** Anyone who can reach port 3000 can use the admin token's powers. It is bound to `127.0.0.1` for that reason (`npm run dev|start` pass `-H 127.0.0.1`, and doctor goes red if 3000 listens on all interfaces). Login is required before any remote access (carry-over to M7).

## Fixture mode (tests and screenshots)

`PORTAL_DATA=fixture` makes the same server module answer from an in-memory fake of the Router API (`src/lib/server/fixtures.ts`): no Docker stack or real key needed, nothing that looks like a credential. State lives in the server process, so tests that change it (add a key, install a CLI, finish the wizard) use their own servers (ports 3211 and 3212, started by `playwright.config.ts`); axe, visual and screenshot runs use port 3210. `PORTAL_FIXTURE_ONBOARDING=none` starts with no wizard record.

```bash
cd apps/portal
npm run build
npx playwright test               # axe (both themes), shell, connections, wizard, visual baselines
npm run test:bundle               # the token check above
npm test                          # unit: recommender, goal mapping, design tokens
npm run budget                    # < 200 KB gzip first-load JS per route
PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3210 &  npm run lighthouse && npm run screens
```

## Connections screen

Real data from `GET /connections` and `GET /catalog`, in three sections (API keys, subscriptions and CLI agents, on this computer).

**API-key cards:** status (icon + text), key last 4, free limits, privacy label (*may train* / *not used for training* / *stays on this machine* / *depends on the model*), paid badge (xAI), last error. **Add key** → password field → router validates against the provider → stored encrypted → card flips to Connected. A rejected key shows the router's message and stores nothing. **Test connection**, **Replace key**, **Remove key** (inline confirm).

**Recommended models** (SPEC §6.4, M1 scope): up to three per card with badges from catalog tags (`src/lib/recommend.ts`, unit-tested):

| Badge | Rule |
|---|---|
| Best for code | tagged `code`; prefers `reasoning`, then larger context |
| Fastest | lowest measured p50 from a passing test; otherwise tagged `fast` |
| Largest context | biggest window among chat models |
| Free | the model's `free` flag |

Untagged models never get a badge and are counted ("N more models are not tagged yet"). Each pick has a **Test** (a direct one-token call with the stored key). "Use for…" and scores are M3.

**CLI cards:** installed / Windows-only / not installed / logged in / unknown (hostprobe down).

- **Install** → the router asks hostprobe for a *plan* → the dialog shows the source URL (and official docs link), pinned version, the installer's SHA-256, the exact commands, what it changes, and "never uses sudo" → **Install** only after you confirm → streamed log → the card flips. Nothing runs before the confirm click.
- **Log in** is never run by the portal. The card shows the exact command for your Ubuntu terminal (with **Copy command**) and **Check again** (a fresh probe that bypasses hostprobe's 30 s cache).

## Install: how it is kept safe

hostprobe (`services/hostprobe/hostprobe.py`) gained the only actions it has:

| Endpoint | Purpose |
|---|---|
| `POST /install/{cli}/plan` | downloads the vendor installer (https, per-CLI host allowlist incl. redirects, ≤ 2 MB, must start with `#!`), returns commands, SHA-256 and a single-use `plan_id` (5 min) |
| `POST /install/{cli}/run` `{plan_id}` | runs **those same bytes** from a temp file; one install at a time (409) |
| `GET /install/jobs/{id}/events?from=N` | SSE log; resumable with `from` / `Last-Event-ID` |
| `POST /install/jobs/{id}/cancel` | stops the process group |

No request field reaches a command: the only input is a `plan_id` that selects a stored plan. Never a shell, never `curl | bash`. A `sudo` shim first on PATH fails any `sudo` call; the service refuses to install as root; the PATH is the clean Linux one (no `/mnt/*`); output is stripped of control characters and token-shaped strings; 10-minute limit. Tests cover single-use plans, expiry, wrong-CLI plan ids, concurrent installs, cancel, timeout, sudo, root refusal, npm prefix outside `$HOME`, and that every table entry is `https`, pinned, host-listed and free of `sudo`/`unsafe-perm`.

### Install methods (verified 2026-11-17, from each installer script)

| CLI | Method (vendor-recommended) | Pinned | Lands in | Touches shell profile |
|---|---|---|---|---|
| claude | `https://claude.ai/install.sh <version>` | 2.1.311 (stable channel) | `~/.local/bin` | no (prints a PATH hint) |
| codex | `https://chatgpt.com/codex/install.sh` with `CODEX_RELEASE`, `CODEX_NON_INTERACTIVE=1` | 0.169.0 | `~/.local/bin`, `~/.codex` | may add a PATH line (`~/.bashrc`/`~/.profile`) |
| gemini | `npm install -g @google/gemini-cli@<v>` (the only method found; Node ≥ 20) | 0.68.0 | nvm global prefix | no |
| grok | `https://x.ai/cli/install.sh <version>` | 1.0.88 | `~/.grok/bin` | may add a PATH line (`~/.bashrc`) |
| opencode | `https://opencode.ai/install --version <v> --no-modify-path` | 1.19.6 | `~/.opencode/bin` | no |

The plan dialog shows each script's SHA-256 (the real ones were read before pinning). To bump a pin, edit `INSTALLS` in hostprobe, re-read the script, and update this table. The plan call hashes whatever the vendor serves today, so a changed script shows a different hash.

## First-run wizard (`/welcome`)

Name (+ Simple/Pro) → goals → connect only what those goals need → preset → finish. Skippable on every step and resumable on any device: progress is saved in the router (`GET/PUT /onboarding`, `system_meta` key `onboarding`). The preset (Free only / Balanced / Best quality) is saved now and applied by the M2 rules engine; "Try it" is a placeholder until M2.

Goal → provider mapping (`goals:` in `config/providers.yaml`):

| Goal | Providers |
|---|---|
| Chat | groq, cerebras, mistral |
| Writing / content | gemini, mistral |
| Code | claude-code, codex, grok-build (paid), opencode, opencode-zen |
| Research | gemini |
| Images | gemini, xai (paid, optional) |
| Video | xai (paid, labelled; no free option exists) |
| Private | ollama |

`xai` is a new API-key provider (OpenAI-style catalog, `paid: true`); claude-code, grok-build and xai carry the paid label.

## Other changes

- **Quick-start chips** under the Home composer fill it (and focus it); they route in M2.
- **Dial loading** is a shimmering ring (an arc orbiting the track; static under reduced motion).
- **ColumnsArt** is redrawn with theme-token fills (entasis, scrolled capitals, entablature).
- Gallery user-facing text moved into `strings.ts` (`dev.gallery`).
- **cacheComponents stays off**: see the comment in `apps/portal/next.config.ts`. All router data is live per request, so only a prerendered shell would be gained; it would also move the first-run redirect into streamed content. Lighthouse is already 99 on every screen.

## Gemini: sweep and the `smart-free` pin

`scripts/gemini-sweep.py` calls `POST /models/test` (a direct one-token call with the stored key) for Gemini catalog models, one call at a time, 7 s apart so the free tier's per-minute limit is not what is measured. Run on 2026-11-17 against this account's free key.

**Pass 1 (every chat-capable model, one round, stopped early once the picture was clear):** the `gemini-3.1-pro-preview` and `gemini-pro-latest` Pro models, the `omni` models and `deep-research-*` returned **429** (no free quota); `gemini-2.5-flash`, `-flash-lite` and `-pro` returned **404** (retired); `antigravity-*` returned **400** (not a chat-completions model); `gemini-3.5-flash` (the old pin) and `gemini-4-hydrogen` **hung to the 60 s timeout**. Not every model was reached before it was stopped; the ones that answered went on to pass 2.

**Pass 2 (12 candidates × 3 rounds):**

| model | ok | p50 ms | max ms | failures |
|---|---|---|---|---|
| `gemini-3-flash-preview` | 3/3 | 908 | 1103 | |
| `gemini-3.1-flash-lite-preview` | 3/3 | 1188 | 1188 | |
| `gemini-3.1-flash-lite` | 3/3 | 1248 | 1297 | |
| `gemini-flash-lite-latest` | 3/3 | 3913 | 4600 | |
| `gemini-3.5-flash-lite` | 3/3 | 4629 | 5225 | |
| `gemma-4-26b-a4b-it` | 2/3 | 1203 | 1290 | 503 overloaded |
| `gemini-flash-latest` | 2/3 | 3135 | 4901 | 503 overloaded |
| `gemini-3.8-flash` | 2/3 | 8753 | 12850 | 503 overloaded |
| `gemini-3.7-flash` | 2/3 | 13347 | 15791 | 503 overloaded |
| `gemma-4-31b-it` | 2/3 | 23254 | 35411 | 503 overloaded |
| `gemini-3.5-flash` (old pin) | **0/3** | - | - | 60 s timeout, then 503 ×2 |
| `gemini-3.6-flash` | 0/3 | - | - | 503 overloaded ×3 |

**Decision:** `smart-free` → `gemini/gemini-3.1-flash-lite` (3/3, about 1.2 s, and not a preview model, so it should not be retired under us). `gemini-3-flash-preview` is the stronger option that also went 3/3 and is a one-line change in `config/providers.yaml` if quality matters more than stability. `num_retries: 0` and `timeout: 30` on that deployment (new per-deployment field in `providers.yaml`, passed through `reconcile.py`), so a failing Gemini call falls back to `local` after one timeout instead of two (~30 s, was ~60 s). Verified live: `smart-free` is served by `gemini/gemini-3.1-flash-lite` (1.4 s) and LiteLLM shows `num_retries=0`.

Caveats: three samples per model is a spot check, not an SLA, and the 503s are Google-side capacity (they came and went within the hour; `gemini-flash-latest` hung in M0 and answered here). Re-run the script when `smart-free` misbehaves: `python3 scripts/gemini-sweep.py --rounds 3 --models id1,id2,…`.
