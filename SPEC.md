# Switchboard — One-Portal AI Command Center (Build Spec)

> Hand this file to Claude Code. Put it in the repo root as `SPEC.md` and reference it from `CLAUDE.md`.
> Working name: **Switchboard**. Rename freely.
> Status of facts: checked Nov 2026. Provider terms, free tiers and CLI flags change often — **verify before implementing** (see §12).

---

## 1. Goal

One local portal where I can:

1. **Chat and build code** in a simple UI.
2. **Generate images and videos** without visiting provider sites.
3. **Connect providers in one click** — subscription CLIs (Claude, ChatGPT/Codex, Gemini, Grok) and API keys (Groq, Gemini, Mistral, OpenRouter, OpenCode Zen, Cerebras, xAI).
4. **Route automatically** to the right agent/model, or **pick manually**.
5. **Set rules as admin**: per request type → target, fallbacks, autonomy level, temperature, cost cap, privacy.
6. **Monitor everything**: tokens, cost, quotas, errors, latency, agent runs, approvals — one dashboard.

Free-tier first, plus 1–2 paid subscriptions. Open source (MIT), runs on one Windows machine, reusable on others.

## 2. Non-goals

- Do **not** rebuild agent orchestration, a model gateway, or a task queue. Reuse Paperclip and LiteLLM through their APIs.
- Do **not** scrape browser chat sites (chatgpt.com, claude.ai, grok.com).
- Do **not** extract subscription OAuth tokens and pass them to any other tool or gateway. Subscription access goes **only** through each vendor's official CLI.
- No Kubernetes, no microservices sprawl. Docker Compose + WSL2.

## 3. Target machine

- Windows 11, 32 GB RAM, 4 GB VRAM GPU.
- **Run everything inside WSL2 (Ubuntu)** with Docker Desktop (WSL backend). Hermes and Grok Build need Linux/macOS/WSL.
- **Ollama**: keep the native Windows install (uses the GPU). Reach it from WSL/Docker at `http://host.docker.internal:11434` (or enable WSL mirrored networking and use `localhost`).
- Local model budget: ≤ ~4B params at Q4 fully on GPU. 7–8B spill to RAM (slow). Local = routing + private tasks, not the main workhorse.

## 4. Architecture

```
                ┌──────────────────────────────────────────────┐
                │          Switchboard Portal (Next.js)        │
                │ Chat · Studio · Agents · Connections · Rules │
                │              · Metrics · Settings            │
                └───────────────┬──────────────────────────────┘
                                │ REST/SSE
                ┌───────────────▼──────────────────────────────┐
                │      Switchboard Router API (FastAPI)        │
                │ classify → apply rules → dispatch → log      │
                └──────┬───────────────────┬───────────────────┘
          chat/image/  │                   │ jobs (code, research, ops)
          video calls  │                   │
        ┌──────────────▼───────┐   ┌───────▼─────────────────────────┐
        │  LiteLLM Proxy       │   │  Paperclip (control plane)      │
        │  API-key models,     │   │  agents, tasks, approvals,      │
        │  fallbacks, spend    │   │  budgets, run logs, costs       │
        └──┬────────┬──────────┘   └───┬──────┬──────┬──────┬────────┘
           │        │                  │      │      │      │
   Groq · Gemini · Mistral ·      Claude  Codex  Gemini  Grok   OpenCode  Hermes
   OpenRouter · Zen · Cerebras ·  Code    CLI    CLI     Build  (Zen)     (→ LiteLLM)
   xAI · Ollama (local)           (Pro)  (ChatGPT)(Google)(SuperGrok)
```

Two kinds of request — the router's **first** decision:

| Kind | Example | Path | UX |
|---|---|---|---|
| **Chat** | "explain this error", "draft an email" | Router → LiteLLM → model | Streams in Chat |
| **Media** | "make a logo", "8s product video" | Router → LiteLLM image/video endpoint (or local ComfyUI) | Studio gallery |
| **Job** | "fix failing tests in repo X", "research competitors" | Router → Paperclip issue assigned to an agent | Job card with live status, approvals, diff/report |

Subscription CLIs talk directly to their vendors, so LiteLLM never sees that traffic. **Metrics must merge LiteLLM spend logs + Paperclip run/cost records + Router decision log.**

## 5. Components

| Component | Role | Notes |
|---|---|---|
| **Portal** (build) | The single UI | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + Recharts |
| **Router API** (build) | Classify, apply rules, dispatch, log, connection checks | Python 3.12 + FastAPI + SQLAlchemy |
| **LiteLLM Proxy** (reuse) | One OpenAI-compatible endpoint for all API-key models; fallbacks; image + video generation; spend tracking | Needs Postgres for spend logs. Admin API to add models/keys |
| **Paperclip** (reuse) | Agent registry, tasks, approvals, budgets, run history | `npx paperclipai@latest onboard --yes`; UI/API on `:3100`. Node ≥ 24.11. Subscription CLIs need Python 3 + the CLI on host |
| **Paperclip plugin** (build, later) | "Routing & Quotas" panel inside Paperclip | Optional; portal is primary |
| **Ollama** (reuse) | Local models + router model | `hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M`, plus a 3–4B general model |
| **ComfyUI** (optional) | Local image generation | 4 GB VRAM: SD1.5 / small SDXL variants only; slow. No local video |
| **Postgres** | Router DB + LiteLLM spend DB | One instance, separate databases |

## 6. Providers and agents

### 6.1 Subscription CLIs (agents, driven by Paperclip)

| Provider | CLI | Login | Use for | Caveat |
|---|---|---|---|---|
| Claude Pro | Claude Code (`claude`) | `claude` → browser login | Heavy coding, refactors, tests | Scarce (rolling usage windows). Use only via the official CLI |
| ChatGPT (Free now, Plus optional) | Codex CLI (`codex`) | `codex login` | Second coder / fallback | Free access is limited and has been promotional |
| Google account | Gemini CLI (`gemini`) | Google login | Long-context reading, research helper | Free limits apply |
| SuperGrok ($30) | Grok Build (`grok`) | `grok auth login` | Parallel coding subagents, plan mode, Imagine (image/video) inside CLI | Beta. **Headless use may bill an xAI API key, not the subscription — verify before routing autonomous jobs to it** |
| OpenCode Zen | OpenCode (`opencode`) | Zen API key | Bulk/cheap coding on free models (Big Pickle, DeepSeek V4 Flash Free, etc.) | Free lineup rotates; some free models may use your data |
| — | Hermes Agent | n/a | Research agent with web/browser tools + memory | Point its model at LiteLLM (`gw/gemini-flash`) |

### 6.2 API-key models (in LiteLLM)

| Alias in LiteLLM | Provider | Use | Privacy note |
|---|---|---|---|
| `fast` | Groq (e.g. gpt-oss-120b) → Cerebras | Quick chat, classification | Groq states no training on API data |
| `smart-free` | Gemini Flash (AI Studio free) | Long context, analysis | Free tier may train on data outside EEA/UK/CH |
| `general` | Mistral (free/experiment) | Summaries, extraction | May train unless opted out |
| `explore` | OpenRouter `:free` models | Fallback / testing | ~50 req/day free (more after $10 credit) |
| `code-free` | OpenCode Zen free models | Code chat | Rotating availability |
| `grok` | xAI API (paid, optional) | Grok text, Imagine image/video | Pay per token / per image / per second |
| `local` / `private` | Ollama | Private tasks, routing | Never leaves the machine |

### 6.3 Media

| Need | Default | Fallback | Reality |
|---|---|---|---|
| Image | Gemini Flash Image (if free quota exists on the account) | xAI Grok Imagine API (~$0.02–0.07/image) → local ComfyUI | Free API image quota is inconsistent — detect at runtime |
| Video | xAI Grok Imagine Video (~$0.05/s at 480p) | Veo / Sora via LiteLLM (paid) | **No reliable free video API.** Enforce a media budget |

Implement media through LiteLLM's image and video generation APIs where supported (it supports Sora and Veo with cost tracking). For xAI Imagine, use LiteLLM if supported in the installed version; otherwise a thin adapter in the Router API calling xAI's OpenAI-style `/v1/images/generations` and `/v1/videos/generations`, with cost logged to the Router DB.

## 7. Routing

### 7.1 Pipeline

1. **Explicit override wins**: model/agent picked in the composer, or a slash command: `/chat /code /research /image /video /private /bulk`.
2. **Hard rules**: attachments (image in + "edit" → image edit; repo path → code job), `private` toggle → local only.
3. **Classifier**: Arch-Router-1.5B on Ollama with route descriptions from `rules.yaml`. Fallback: `fast` model with a JSON-schema classification prompt.
4. **Rule match** → target + fallbacks + autonomy + temperature + caps.
5. **Health/quota check**: skip targets that are down, out of quota, cooling down after 429, or over budget.
6. **Dispatch** and **log the decision** (inputs, matched rule, chosen target, skipped targets with reasons, latency).

### 7.2 Rules file (`config/rules.yaml`, editable in the Rules UI)

```yaml
defaults:
  temperature: 0.4
  autonomy: 1          # see 7.3
  max_cost_usd: 0.50   # per request
  private: false

rules:
  - id: private
    when: { private: true }
    target: model:local
    fallbacks: []

  - id: code-heavy
    when: { intent: code, size: large }
    target: agent:claude-code
    fallbacks: [agent:grok-build, agent:codex, agent:opencode]
    autonomy: 2
    temperature: 0.2

  - id: code-light
    when: { intent: code, size: small }
    target: model:code-free
    fallbacks: [model:fast]
    temperature: 0.2

  - id: research
    when: { intent: research }
    target: agent:hermes
    fallbacks: [agent:gemini-cli]
    autonomy: 1

  - id: image
    when: { intent: image }
    target: media:image-default
    max_cost_usd: 0.10

  - id: video
    when: { intent: video }
    target: media:grok-imagine-video
    autonomy: 0          # always confirm cost before generating
    max_cost_usd: 1.00

  - id: default
    when: {}
    target: model:fast
    fallbacks: [model:general, model:smart-free, model:explore, model:local]
```

Per-user overrides stored in DB; admin rules are the base. Rule edits are versioned (keep history, allow rollback).

### 7.3 Autonomy levels (one scale, mapped per agent)

| Level | Meaning | Maps to (verify exact flags per CLI version) |
|---|---|---|
| 0 Suggest | Plan/answer only, no changes | Claude Code plan mode; Codex read-only; Paperclip task requires review |
| 1 Ask | Edits and commands need approval | Default permission modes; Paperclip approval gate before completion |
| 2 Auto-edit | Edits allowed in a git worktree; commands/network need approval | Claude Code accept-edits; Codex workspace-write sandbox |
| 3 Full auto | Runs end-to-end in sandbox/worktree; human reviews result | Only inside Docker/worktree; never on real accounts or secrets |

Default is 1. Level 3 requires: sandbox on, budget set, git worktree, no production credentials.

## 8. Portal screens

1. **Chat** — threads, streaming, file/image attach, composer with: `Auto` / manual target picker, temperature slider, autonomy selector, private toggle. Each reply shows a chip: *routed to X by rule Y* (click → decision log). "Convert to job" button.
2. **Studio** — image and video generation, gallery, prompt history, per-item cost, re-run with another provider. Cost confirmation for video.
3. **Agents & Jobs** — list Paperclip agents with status; job board (queued / running / needs approval / done); live log stream; diff or report view; approve / reject / stop. Deep-link to Paperclip for advanced config.
4. **Connections** — one card per provider:
   - *CLI providers*: detect installed (`<cli> --version`), detect logged-in, **Install** and **Log in** buttons (opens a terminal/browser OAuth via the CLI itself), **Test** button.
   - *API-key providers*: paste key → stored server-side → registered in LiteLLM → **Test** → shows models + current limits.
   - Health dot, quota remaining (where the provider exposes it), last error.
5. **Rules** — table + form editor for `rules.yaml`, "test a prompt" dry-run showing which rule fires, version history.
6. **Metrics** — date range filter; tokens and cost by provider / model / agent / rule; requests, errors, 429s, latency p50/p95; quota burn-down; media spend; Paperclip budget status; top expensive requests.
7. **Settings** — users/roles (admin, user), budgets, data-retention, export/import config.

Design: calm "dreamy sky" glass (Day sky / Dusk), keyboard-first (⌘K command palette), mobile-friendly read-only. See §8c.

## 8a. Workflow packs (gstack, OpenSpec, Spec Kit, Superpowers, BMAD)

These are **not models**. They are folders of Markdown skills / slash commands that live in a repo (or `~/.claude/skills`, `.agents/skills`) and run **inside** a coding agent. The gateway supplies models; packs supply the method. Switchboard manages both.

| Pack | What it adds | Install (verify) | Host agents | Notes |
|---|---|---|---|---|
| **OpenSpec** | Spec-first changes for existing code: propose → apply → archive (`openspec/changes/<name>/`) | `npm i -g @fission-ai/openspec@latest` → `openspec init` | Claude Code, Codex, OpenCode, Cursor, 20+ | Node ≥ 20.19. No API keys. Best default for brownfield |
| **gstack** | Role skills: plan reviews, `/review`, `/qa`, `/ship`, `/cso` security, `/browse`, `/codex` second opinion | `git clone https://github.com/garrytan/gstack ~/.claude/skills/gstack && ./setup` (`--host codex` for Codex) | Claude Code first; Codex and others | Needs Bun; `/browse` builds a native binary → run in WSL |
| **GitHub Spec Kit** | Gated pipeline: specify → plan → tasks → implement | `specify` CLI (Python/uv) | 30+ agents | Heavier; good for greenfield |
| **Superpowers** | Enforced brainstorm → plan → TDD → review loop | Claude plugin marketplace / skills | Claude Code, Codex, Gemini CLI, more | Very popular; strict discipline |
| **BMAD** | Agile roles and documents (PM, architect, dev, QA) | Its installer | Multiple | Large; optional |

### Portal features for packs

1. **Pack library** (Connections → Packs): install / update / remove per agent (global) or per project (repo). Shows version, host compatibility, what it does in one line.
2. **Project setup**: when a repo is added, offer a preset: *Light* (OpenSpec), *Ship-fast* (OpenSpec + gstack review/qa/ship), *Strict* (Superpowers or Spec Kit).
3. **Composer actions**: installed pack commands appear as chips in the composer when a project is selected (e.g. *Propose change*, *Review*, *QA*, *Ship*, *Security audit*). The chip sends the slash command to the job's agent.
4. **Phase routing** (this is where the gateway pays off): rules can target a pack phase, so each phase uses a different agent/model.

```yaml
pack_routes:
  openspec.propose:   { target: model:smart-free,  temperature: 0.3, autonomy: 0 }   # cheap spec writing
  openspec.apply:     { target: agent:claude-code, fallbacks: [agent:grok-build, agent:opencode], autonomy: 2 }
  gstack.review:      { target: agent:codex,       autonomy: 0 }   # second model reviews first model's work
  gstack.qa:          { target: agent:claude-code, autonomy: 1 }
  gstack.ship:        { target: agent:claude-code, autonomy: 1 }   # always asks before push/PR
```

5. **Artifacts view**: render the pack's files (proposal.md, design.md, tasks.md, review reports) as clean cards with approve / request-changes buttons, instead of raw Markdown.
6. Packs are **opt-in and lazy**: never load every skill into every session (context cost). Load only the pack bound to the project and phase.

Hosting rule: packs run inside official CLIs (Claude Code with the Pro login, Codex, etc.) or API-key agents (OpenCode, Hermes via LiteLLM). Never inject subscription tokens elsewhere to "make a pack work".

### Pack registry: any pack, installed on demand (nothing pre-installed)

The table above is the **starter catalog**, not a fixed list. No pack is pre-installed. The user picks a pack in the portal → the backend installs it → the portal refreshes → its commands appear as composer chips. New packs (e.g. graphify or any future skill pack) are added by dropping a manifest, with no code changes.

`packs/<id>/pack.yaml`:

```yaml
id: openspec
name: OpenSpec
summary: Agree on a spec before code; propose → apply → archive.
source: npm:@fission-ai/openspec            # or git:<url>@<tag>, or skills:<url>
requires: [node>=20.19]                      # checked by doctor before install
scope: [project, global]
hosts: [claude-code, codex, opencode, gemini-cli]
install:
  global:  ["npm i -g @fission-ai/openspec@latest"]
  project: ["openspec init --tools {hosts}"]
uninstall:
  global:  ["npm rm -g @fission-ai/openspec"]
detect: ["openspec --version"]
commands:                                    # become composer chips
  - { id: propose, label: Propose change, run: "/opsx:propose" }
  - { id: apply,   label: Apply,          run: "/opsx:apply" }
  - { id: archive, label: Archive,        run: "/opsx:archive" }
artifacts: ["openspec/changes/**/*.md"]      # rendered as cards
```

Installer service rules:
1. Runs install commands in a **sandboxed job** inside WSL with live log streaming to the UI; never as root unless the user approves.
2. Shows the exact commands, source URL and pinned version **before** running (one-click confirm).
3. Pins versions; supports update and rollback; records every install in the activity log.
4. After install: run `detect`, register commands, hot-reload the portal (no restart).
5. Community catalog: the portal can fetch an index of manifests from a GitHub repo; unverified packs are labelled and require an extra confirm.

## 8b. Onboarding and in-product explanations

Users must always know **what** they are using, **why** it was picked, and **what it costs**.

**First-run wizard (≤ 5 minutes, skippable, resumable)**
1. *Welcome*: one sentence on what Switchboard does; choose mode **Simple** (default) or **Pro**.
2. *What do you want to do?* checkboxes: chat, code, research, images, video, private work.
3. *Connect*: only the providers needed for the chosen goals. Each card answers in plain words: what it is · free or paid · limits · whether data may be used for training · one-click login/test.
4. *Pick a preset*: **Free only** / **Balanced** (free + your subscriptions) / **Best quality**. Presets write `rules.yaml`; editable later.
5. *Try it*: three sample tasks (a chat, an image, a small code job) that show routing, cost and approvals live.

**Always-on explanations**
- Every reply / job / media item has a **"Why this?"** chip: rule matched, model/agent chosen, fallbacks skipped and why, cost, tokens.
- `?` icon on every setting opens a 2–3 line explanation + "learn more".
- **Glossary** drawer: agent, model, gateway, autonomy, pack, quota, fallback, worktree — one line each.
- Empty states teach (e.g. empty Jobs board explains what a job is and offers a sample).
- `doctor` results shown in plain language with a **Fix** button where possible.
- Cost and privacy warnings appear **before** an action (video, paid model, data-training provider), never after.
- Simple mode hides: raw YAML, temperatures, fallbacks, logs. Pro mode reveals them.

## 8c. Design system: calm, glassy "dreamy sky", low cognitive load

**Mood.** Calm, premium, airy. One accent (periwinkle/lavender, `#8B8FE8` family); everything else is white, glass or neutral. Status colors only for state (healthy / warning / error).

**Themes** (default follows the OS; manual override in the Appearance menu)
- **Day sky** (light): pastel sky gradient: peach, pink, sky blue, lavender, with slow cloud drift.
- **Dusk** (dark): deep indigo to violet.
- Backdrop is CSS gradients by default (0 KB). An optional **Sky image** toggle swaps in our own AVIF (`public/sky/*.avif`, < 150 KB each, generated by `npm run gen:sky`; no third-party assets).

**Typography.** Huge, tight-tracked display headings; tiny uppercase tracked labels. Plus Jakarta Sans (display) + Geist (UI) + Geist Mono, all OFL, self-hosted through `next/font`. Three type sizes per screen at most.

**Surfaces**
- Glass is for **containers only** (nav pill, cards, composer, modals): `backdrop-filter` blur 14 / 24 px, translucent white fill, 1 px hairline border, 20–28 px radius, soft shadow.
- **Text sits on near-opaque surfaces** (`glassStrong`, >= 90% opaque) and must meet WCAG AA (4.5:1); enforced by `design-tokens.test.ts` over every sky stop in both themes.
- **Code, diffs and logs live on solid panels** (`solid`, 7:1).
- At most **two stacked blur layers**: `GlassPanel` tracks depth and drops a third layer's blur.
- `prefers-reduced-transparency` and a manual **Solid surfaces** switch replace glass with opaque panels; `prefers-reduced-motion` removes animation (Motion `reducedMotion="user"` plus CSS).

**Signature component: the Dial.** A 270° ring with a periwinkle arc and a dot handle. Read-only (`role="meter"`) for quotas and budgets; interactive (`role="slider"`, arrows/Home/End/PageUp/PageDown, pointer drag) for the autonomy selector, which snaps to the four stops in §7.3.

**Layout and interaction**
- **Top navigation** as white pill tabs: Chat · Studio · Jobs · Connections · Metrics, plus Settings, the Simple/Pro switch, Appearance menu, ⌘K trigger and one periwinkle pill primary action. Phones get a bottom bar instead. Rules live in Settings in Simple mode.
- **Home**: "Hello, {name}. What do you want to build today?" and one large glass composer.
- One primary action per screen. Details in side drawers, not new pages.
- Progressive disclosure: summaries first, expand for detail. Cards carry three numbers at most.
- ⌘K command palette for navigation and preferences; keyboard-first, visible focus rings everywhere.
- Notifications batched in one toast region; approvals are the only thing that interrupts.
- **Comfortable / Compact** density toggle. Responsive: desktop, tablet, phone (phone is read-only).
- The columns motif (original artwork) appears only on onboarding and login.

**Motion.** 150-250 ms, spring easing, 90 s cloud drift, 3 s "breathing" status dots. Motion (`motion/react`) with `LazyMotion` so animation features load after first paint.

**States.** Every component has loading (soft shimmer), empty, error and disabled states. **Status is never conveyed by color alone**: icon + text + color.

**Copy.** All UI strings live in `apps/portal/src/i18n/strings.ts`.

**"Non context heavy" (performance and tokens)**
- UI: initial JS < 200 KB gzip per route (checked by `npm run budget`), heavy overlays (palette, popovers) load on demand, Lighthouse performance / accessibility / best-practices >= 90.
- LLM context: send only what the task needs: auto-summarize long threads, attach files by reference, load pack skills only for the active phase, cap context per rule (`max_context_tokens`). Show context size in the "Why this?" chip.

**Deliverables for this section** (shipped in M0.5): `design-tokens.ts` (both themes, single source for the generated CSS variables), a component kit on shadcn/ui-style primitives (GlassPanel, PillTabs, Dial, StatCard, RouteChip, ProviderCard, JobCard, CostBadge, ExplainPopover, Composer, Toast, Skeleton, EmptyState), the app shell, and the `/dev/components` gallery.

## 8d. Content Studio (text, image, video, audio)

One place for all non-code creation, e.g. LinkedIn posts, blogs, emails, carousels, thumbnails, short videos. Posting stays **manual** (copy / download); no social-network APIs needed.

**Features**
- **Templates**: LinkedIn post, LinkedIn carousel, X thread, blog, newsletter, email, YouTube script, product description. Each template = prompt + length + format + default route.
- **Voice profiles**: paste 5–10 of my past posts → saved style guide (tone, length, hooks, emoji use, banned phrases). Selectable per draft.
- **Drafts library**: status (idea → draft → final → posted), tags, version history, side-by-side variants (generate 3, pick one).
- **Media pairing**: "Make visual" on any draft → Studio image/video with the draft as context; result attached to the draft.
- **Export**: copy-ready text, image/video download, optional calendar note of when I posted.
- **Content metrics**: tokens and cost per draft and per channel; count of drafts/posts per week.

**Rules appended to `rules.yaml`** (additions only)

```yaml
  - id: writing
    when: { intent: writing }            # posts, emails, blogs
    target: model:smart-free
    fallbacks: [model:general, model:fast]
    temperature: 0.8
    autonomy: 0

  - id: writing-premium
    when: { intent: writing, quality: high }
    target: model:grok                    # or a subscription agent in plan mode
    fallbacks: [model:smart-free]
    temperature: 0.7
    max_cost_usd: 0.05

  - id: audio
    when: { intent: audio }              # voiceover / TTS, optional
    target: media:tts-default
    max_cost_usd: 0.20
```

## 8e. Capability coverage (single source of truth)

| Field | Where in portal | Default route | Fallback | Tracked | Limits |
|---|---|---|---|---|---|
| Quick chat / Q&A | Chat | `fast` (Groq) | Mistral → Gemini → OpenRouter → local | LiteLLM spend → Metrics | per-request + daily |
| Writing / social content | Content Studio | `smart-free` (Gemini) | Mistral → fast | LiteLLM → Metrics (tag: content) | per-request + daily |
| Research | Jobs | Hermes agent | Gemini CLI | Paperclip runs + LiteLLM | Paperclip agent budget |
| Coding (heavy) | Jobs / Chat | Claude Code | Grok Build → Codex → OpenCode | Paperclip runs | Paperclip budget + usage windows |
| Coding (light) | Chat | `code-free` (Zen) | fast | LiteLLM | per-request |
| Spec / review workflows | Jobs (packs) | per-phase routes (§8a) | per-phase | Paperclip + LiteLLM | per-phase caps |
| Image | Studio / Content | Gemini Flash Image (if free) | Grok Imagine → ComfyUI local | Router media log | media daily cap |
| Video | Studio / Content | Grok Imagine Video | Veo / Sora | Router media log | confirm + media cap |
| Audio / TTS (optional) | Studio | provider TTS via LiteLLM | — | LiteLLM | media cap |
| Private / sensitive | Any (toggle) | Ollama local | none (never leaves machine) | Router log | — |
| Model & provider handling | Connections + Settings → Rules | presets + rules.yaml | health/quota-aware fallback | Router decision log | global caps |

Every row lands in the same `costs` table → one Metrics dashboard, filterable by field (chat, content, code, research, image, video, audio).

## 8f. Buildability and risks

Buildable by one person with Claude Code: the hard parts (agents, gateway, queues, media APIs) are reused; the new code is a UI, a rules engine, adapters and a metrics merger.

| Risk | Mitigation |
|---|---|
| Free tiers change or vanish | `providers.yaml` registry + health checks + fallbacks; nothing hard-coded |
| Subscription terms change (Claude, OpenAI, xAI) | Subscriptions only via official CLIs; API-key path always available |
| Paperclip / LiteLLM API changes | Thin adapter layer per dependency; pin versions; contract tests |
| Windows/WSL friction | Everything in WSL2 + Docker; `setup-wsl.sh` + `doctor.sh` |
| Video and premium costs | Confirm-before-spend, media cap, daily cap |
| Scope creep | Ship milestone by milestone; each must work on its own |

## 9. Data model (Router DB)

- `users(id, role)`
- `connections(id, provider, kind[cli|api_key|local], status, last_checked, last_error, meta_json)` — secrets **not** stored here; API keys live in LiteLLM / encrypted secret store
- `rules(id, version, yaml, created_by, created_at, active)`
- `user_overrides(user_id, rule_id, json)`
- `requests(id, user_id, kind[chat|media|job], prompt_hash, rule_id, target, fallbacks_tried_json, temperature, autonomy, private, status, latency_ms, created_at)`
- `costs(request_id, source[litellm|paperclip|router], provider, model, tokens_in, tokens_out, units, cost_usd)`
- `jobs(request_id, paperclip_issue_id, agent, status, approval_state)`
- `media(request_id, type, provider, file_path, cost_usd)`

Metrics service pulls LiteLLM spend logs and Paperclip run/cost data on a schedule (and on webhook if available) and writes into `costs`, so all dashboards read one table.

## 10. Repo layout

```
switchboard/
  apps/portal/            # Next.js UI
  services/router/        # FastAPI
  plugins/paperclip/      # optional Paperclip panel
  config/
    rules.yaml
    litellm.yaml
    providers.yaml        # registry: capabilities, limits, privacy flags
  deploy/
    docker-compose.yml    # portal, router, litellm, postgres, (comfyui)
    .env.example
  scripts/
    setup-wsl.sh          # installs CLIs, checks Ollama reachability
    doctor.sh             # health check of every component
  docs/
  CLAUDE.md
  SPEC.md
  LICENSE (MIT)
```

Paperclip runs from its own install (not vendored). Ollama runs on Windows.

## 11. Milestones (each must leave a working system)

| # | Deliverable | Done when |
|---|---|---|
| M0 | Infra: WSL2, Docker, Postgres, LiteLLM with Ollama + Groq + Gemini; Paperclip running; `doctor.sh` | `doctor.sh` all green; a curl to LiteLLM `fast` and `local` works |
| M0.5 | Design system (§8c): tokens, glass component kit, app shell, ⌘K, Simple/Pro mode | `/dev/components` renders in both themes and all states; reduced-transparency fallback works; AA contrast passes; axe clean; Lighthouse >= 90; visual baselines committed |
| M1 | Connections screen + API + first-run wizard (§8b) | Can add/test API keys from UI; CLI cards show installed/logged-in for Claude Code, Codex, Gemini CLI, Grok Build, OpenCode; wizard completes end to end |
| M2 | Chat + Router (rules only, no classifier yet) | Manual pick and slash commands work; fallback on 429 verified; decision chip shown |
| M3 | Rules UI + Arch-Router classifier | Dry-run tester; ≥ 85% correct on a 50-prompt labelled set in `tests/routing.jsonl` |
| M4 | Jobs via Paperclip | "Fix tests in repo X" creates a Paperclip issue for the right agent; live status, approve/reject, diff view |
| M4.5 | Workflow packs (§8a): library, project presets, composer chips, phase routing, artifacts view | OpenSpec propose (free model) → apply (Claude Code) → gstack review (Codex) runs on a sample repo with each phase logged |
| M5 | Studio (image + video) | Image via free route or xAI; video via xAI with cost confirm; costs logged |
| M5.5 | Content Studio (§8d): templates, voice profiles, drafts library, media pairing, export | A LinkedIn post + matching image created, versioned, exported; cost shown under "content" in Metrics |
| M6 | Metrics dashboard | All three cost sources merged; filters by provider/model/agent/rule; quota burn-down |
| M7 | OSS packaging | One-command setup on a fresh Windows+WSL machine; README with screenshots; MIT; CI lint/tests |

## 12. Verify before implementing (do not assume)

- Paperclip REST API endpoints for: create issue, assign agent, read run status/logs, read cost records, approvals. Check the installed version's docs/source.
- Paperclip adapter names and config for Claude Code, Codex, Gemini CLI, Grok Build, OpenCode, Hermes.
- Grok Build: whether headless/automated runs use the SuperGrok subscription or require an xAI API key; Windows/WSL install.
- Codex CLI access on ChatGPT Free at build time.
- Claude Code / Codex permission-mode flag names for autonomy mapping.
- LiteLLM support for xAI image/video in the installed version.
- Current free-tier limits per provider (seed `providers.yaml` from `cheahjs/free-llm-api-resources`, then confirm in each console).
- Anthropic, OpenAI, Google and xAI terms for automated use of subscriptions.
- Install commands, host support and Windows/WSL behaviour for each workflow pack (gstack needs Bun; OpenSpec needs Node ≥ 20.19).

## 13. Security rules (non-negotiable)

1. Bind everything to `localhost` by default; remote access only via authenticated tunnel (e.g. Tailscale) later.
2. Secrets server-side only; never in frontend code, logs or git. `.env` in `.gitignore`.
3. Never copy subscription OAuth tokens between tools.
4. Agents with autonomy ≥ 2 run in a git worktree or container; no access to `~/.ssh`, browser profiles or password stores.
5. Every request is traceable: request id, rule, target, fallbacks, tokens, cost, approvals.
6. Hard budget caps: per request, per day, and for media separately.

## 14. Inspiration (read, don't fork blindly)

- Paperclip — agent control plane (core dependency)
- 9Router / OmniRoute — quota dashboard and fallback-chain UX (skip their subscription-OAuth passthrough)
- Plano + Arch-Router — preference-based routing
- RouteLLM (LMSYS) — strong/weak model routing ideas
- Open WebUI — chat UX patterns
- Hermes Agent — research agent
- OpenSpec, gstack, GitHub Spec Kit, Superpowers, BMAD — workflow packs (§8a)
