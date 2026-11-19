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
| `explore` | OpenRouter `:free` models | Fallback / testing | ~50 req/day free (more after $10 credit). M3a: dynamic, the best available `:free` chat model in the live catalog (`pick: best-free`), because pinned free models kept being retired |
| `code-free` | OpenCode Zen free models | Code chat | Rotating availability |
| `grok` | xAI API (paid, optional) | Grok text, Imagine image/video | Pay per token / per image / per second |
| `local` / `private` | Ollama | Private tasks, routing | Never leaves the machine |

### 6.3 Media

| Need | Default | Fallback | Reality |
|---|---|---|---|
| Image | Gemini Flash Image (if free quota exists on the account) | xAI Grok Imagine API (~$0.02–0.07/image) → local ComfyUI | Free API image quota is inconsistent — detect at runtime |
| Video | xAI Grok Imagine Video (~$0.05/s at 480p) | Veo / Sora via LiteLLM (paid) | **No reliable free video API.** Enforce a media budget |

Implement media through LiteLLM's image and video generation APIs where supported (it supports Sora and Veo with cost tracking). For xAI Imagine, use LiteLLM if supported in the installed version; otherwise a thin adapter in the Router API calling xAI's OpenAI-style `/v1/images/generations` and `/v1/videos/generations`, with cost logged to the Router DB.

### 6.4 Model catalog and in-provider recommendation

Routing chooses the **provider and the model**, not just the provider.

**Catalog**
- On startup and every 24 h, pull each connected provider's live `/models` list (via LiteLLM where possible, else the provider API).
- Store per model: provider, model id, display name, capability tags (`chat`, `code`, `reasoning`, `vision`, `long-context`, `fast`, `image`, `video`, `audio`), context window, max output, free-tier limits (from `config/providers.yaml`), price per 1M tokens / per image / per second, privacy flag (`no-training` | `may-train` | `local`), status (`available` | `deprecated` | `missing`).
- Tags come from `config/model-tags.yaml` (curated, human-editable), with provider metadata as fallback. Unknown new models show as "untagged" until tagged.

**Recommendation**
- Hard filters first: privacy, budget, context size, required capability.
- Then score = capability match for the task + measured quality (thumbs up/down) + measured latency + success rate + quota headroom + cost, within the privacy constraint.

**Learning**
- Record per model and task type: latency p50/p95, error/429 rate and user feedback. Recompute scores daily.
- Never auto-pick a model with fewer than 5 samples over a proven one, unless the user enables "explore".

**Explainability.** The "Why this?" chip shows provider, model, the top 3 reasons, and the runner-up.

**Implemented in M3a** (`services/router/app/routing/recommend.py`, docs/m3a.md):
- **Score.** `score = Σ weight·term / Σ weight`. The terms run 0..1: capability (has the tag, +0.3 for the task's own tag), feedback (`(up+1)/(up+down+2)` per task type), latency (`1 − p50/8 s`), success (`(ok+1)/(n+2)`), quota headroom, cost (free = 1) and privacy (no-training/local 1, varies 0.5, may-train 0.3). The weights are in `rules.yaml` → `recommender`.
- **Samples.** "Samples" are a model's real answers over every task type (the 1-token test pings count only for latency).
- **Explore.** "Explore" is the Settings → Routing switch: unproven models then compete on score, and the reason says so.
- **Where it applies.** The recommender serves `best:<capability>` targets and dynamic aliases (`explore`).

**UI**
- Connections provider cards list recommended models with badges ("Best for code", "Fastest", "Largest context", "Free") and a "Use for…" action that writes a rule override.
- The Composer's model picker groups models by provider with the same badges.
- Manual choice always overrides.

**Rules.** A rule target can be a specific model (`model:groq/openai/gpt-oss-120b`), an alias (`model:fast`) or a capability (`best:code`, `best:fast`, `best:long-context`) resolved by the recommender.

**Data** (Router DB)
- `model_catalog(id, provider, model_id, tags_json, context, prices_json, privacy, status, updated_at)`
- `model_stats(model_id, task_type, samples, p50_ms, p95_ms, error_rate, thumbs_up, thumbs_down, score, updated_at)`

## 7. Routing

### 7.1 Pipeline

1. **Explicit override wins**: model/agent picked in the composer, or a slash command: `/chat /code /research /image /video /private /bulk`.
2. **Hard rules**: attachments (image in + "edit" → image edit; repo path → code job), `private` toggle → local only.
3. **Classifier**: Arch-Router-1.5B on Ollama with route descriptions from `rules.yaml`. ~~Fallback: `fast` model with a JSON-schema classification prompt.~~ M3a: strong keyword signals decide first, with no model call. The fallback, when the classifier is down, reloading, slower than 1.5 s or unclear, is the keyword heuristics, including a first-person sensitive check (docs/m3a.md).
   - **Auto-private (M3a).** A message classified as sensitive (health, finance, legal, personal) goes local and makes the thread private, with a "Not sensitive — use cloud" override. Settings → Privacy can turn it off.
   - **Secrets (M3a).** A pasted secret (API key, token, private key, password, card number) always goes local, with no override, and is masked in everything stored.
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

M3a adds these `rules.yaml` blocks: `classifier:` (timeout, breaker, `routes` with descriptions and facts), `recommender:` (weights, `min_samples`), `quota:` (`reroute_at` 0.8, `block_at` 1.0) and `summary:` (`start_at` 0.75, `keep_last` 6). The local-model profiles live in `config/local-models.yaml`.

Implemented in M2 as `config/rules.yaml` (docs/m2.md). It adds `defaults.daily_cap_usd`, `max_context_tokens`, `max_output_tokens`, a `slash:` map (command → rule), `presets:` (free / balanced / best overlays and a paid policy), `when: { command: … }` and `job: true`. Until M4, `agent:` targets are skipped with a reason, and the chat models at the end of a rule's fallbacks answer in chat. DB overrides and versioning come with the Rules UI (M3).

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
2. *What do you want to do?* checkboxes: chat, writing/content, code, research, images, video, private work. The goal → provider mapping lives in `config/providers.yaml` (`goals:`).
3. *Connect*: only the providers needed for the chosen goals. Each card answers in plain words: what it is · free or paid · limits · whether data may be used for training · one-click login/test.
4. *Pick a preset*: **Free only** / **Balanced** (free + your subscriptions) / **Best quality**. Presets write `rules.yaml`; editable later. (M1b saves the choice in the Router DB, `system_meta` key `onboarding`; the M2 rules engine applies it.)
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

**Motion.** 150-300 ms for every UI transition (tokens: fast 150, base 200, slow 250, enter 220, exit 150, stagger 30 ms; `ease`, `easeOut`, `easeIn`; spring presets), 90 s cloud drift, 3 s "breathing" status dots. Transform and opacity only; nothing scroll-linked. Page transitions animate client navigations only (never the first paint); lists stagger at most 8 items and never start fully transparent; cards lift 1 px on hover; buttons press to 0.97; toasts spring; streamed Markdown blocks fade in once. Everything stops under `prefers-reduced-motion` **or** Settings → Appearance → Motion: Reduce (`html[data-motion]`). Motion (`motion/react`) with `LazyMotion` so animation features load after first paint; simple transitions are CSS (the Dial too, M1.5).

**Ambient cursor (M1.5).** The native cursor and the text I-beam are never hidden or replaced. A soft periwinkle glow follows the pointer behind the content, and the edge of the glass card under it lights up. Desktop with a fine pointer only; off on touch, under reduced motion and via Settings → Appearance. CSS variables + one requestAnimationFrame per frame, no React renders.

**Tooltips (M1.5).** One tooltip, driven by `data-tip` (or `data-tip-truncated` for cut-off text). Only on icon-only buttons and jargon terms, at most one short sentence. Opens after ~500 ms of hover, closes after 100 ms, shows on keyboard navigation, Esc closes it, one at a time, collision-aware, never on touch.

**Scrollbars (M1.5).** Thin and themed; thumbs hidden at rest and shown on hover, focus or while scrolling (gutter reserved, so nothing shifts). No horizontal scrolling in lists or panels; long titles use a single-line ellipsis with the full title in the tooltip.

**Chrome (M1.5).** A slim glass footer (health dots → Status view, today's spend and value saved, quota, version, links; an icon row on phones), a CSS-only first-load splash (≤ 1.2 s, never blocks input, once per session, none under reduced motion), route skeletons sized like the page (CLS < 0.05), and a keyboard shortcuts sheet on `?` built from the same registry as the handlers.

**Errors (M1.5).** Never show raw JSON or HTTP text on cards or in chat: one plain sentence and at most one action, from a stable error code; the raw detail only in Pro mode under "Details".

**States.** Every component has loading (soft shimmer), empty, error and disabled states. **Status is never conveyed by color alone**: icon + text + color.

**Copy.** All UI strings live in `apps/portal/src/i18n/`: core text in `strings.ts`, feature text in its own module next to it (`chat.ts`, `connections.ts`, `wizard.ts`, `dev.ts`) so each route ships only its own strings (M2, JS budget).

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
- `requests(id, user_id, kind[chat|media|job], prompt_hash, rule_id, target, fallbacks_tried_json, temperature, autonomy, private, status, latency_ms, created_at, thread_id, intent, model, model_catalog_id, ttft_ms, error, decision_json)`: the M2 columns record the deployment that answered and the full decision
- `costs(request_id, source[litellm|paperclip|router], provider, model, tokens_in, tokens_out, units, cost_usd, list_price_usd)`: `cost_usd` counts toward caps (free-tier calls are $0); `list_price_usd` keeps the provider's price as "value" (M2)
- `threads(id uuid, title, title_source[none|words|local|user], private, created_at, updated_at, private_source, summary_json)`: `private` is sticky (M2). `private_source` is user | slash | auto | secret, and only `auto` can be overridden. `summary_json` holds the running summary of older turns (M3a)
- `quota_usage(provider, scope_key, window[m|d], window_start, requests, tokens)`, `quota_headers(provider, scope_key, data, seen_at)`, `cooldowns(target, provider, code, reason, until)`: the quota guard and persisted cooldowns (M3a)
- `messages(id, thread_id, role, content, status[streaming|done|stopped|error|notice|blocked], request_id, private, feedback, meta_json, created_at)`: reasoning text is never stored; `meta_json` holds the "Why this?" data (M2)
- `jobs(request_id, paperclip_issue_id, agent, status, approval_state)`
- `media(request_id, type, provider, file_path, cost_usd)`
- `model_catalog(id, provider, model_id, tags_json, context, prices_json, privacy, status, updated_at)` (see §6.4)
- `model_stats(model_id, task_type, samples, p50_ms, p95_ms, error_rate, thumbs_up, thumbs_down, score, updated_at)` (see §6.4)
- `provider_secrets(provider, ciphertext, last4, source, created_at, updated_at)` — the "encrypted secret store" above: Fernet with `SWITCHBOARD_SECRET_KEY`; never returned by the API (M1a)
- `system_meta(key, value, updated_at)` — install facts, e.g. SHA-256 fingerprints of `SWITCHBOARD_SECRET_KEY` / `LITELLM_SALT_KEY` checked by `doctor.sh` (M1a)

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
| M1 | Connections screen + API + first-run wizard (§8b) | Can add/test API keys from UI; CLI cards show installed/logged-in for Claude Code, Codex, Gemini CLI, Grok Build, OpenCode; wizard completes end to end; the model catalog (§6.4) is populated from live provider lists, and provider cards show tagged recommended models |
| M1a | Router backend (§5, §6.4, §9, §13): `services/router` (FastAPI) + hostprobe, connections API, model catalog, LiteLLM reconcile | `doctor.sh` green incl. router; catalog shows live, tagged models for every keyed provider; add/test/remove key via API; CLI detection correct; tests pass |
| M1b | Connections UI + first-run wizard (§8b) + quick-start chips on top of the M1a API | Can add/test API keys from UI; CLI cards show installed/logged-in; provider cards show tagged recommended models; wizard completes end to end |
| M2 | Chat + Router (rules only, no classifier yet) | Manual pick and slash commands work; fallback on 429 verified; decision chip shown |
| M1.5 | Design polish + self-healing (§8b, §8c), built after M2: shell (footer, splash, shortcuts, transitions), chat sidebar and reading column, Settings, motion v2, ambient cursor, one tooltip; idempotent LiteLLM sync, plain-language errors, Status view | Every UI item in §8c below works in both themes; axe clean; Lighthouse ≥ 90; JS ≤ 200 KB per route; CLS < 0.05; LiteLLM restart or a lost deployment resyncs with no user action |
| M3 | Rules UI + Arch-Router classifier | Dry-run tester; ≥ 85% correct on a 50-prompt labelled set in `tests/routing.jsonl`; `best:<capability>` targets resolve via the recommender, the "Why this?" chip shows model + top reasons, and feedback updates `model_stats` |
| M3a | Routing brain (backend first): Arch-Router classifier, recommender scoring, quota guard, generic OpenAI-compatible adapter, long-thread summaries, local-model profiles, auto-private + secret masking | ≥ 85% on ≥ 60 labelled prompts (`services/router/tests/routing.jsonl`); quota guard reroutes before a 429 (test + live demo); a provider added with YAML only (test); summaries work; M1.5 carry-overs fixed |
| M3b | Rules UI: table + form editor over `rules.yaml`, DB overrides and versioning with rollback, dry-run tester | Edit a rule in the UI, test a prompt, roll back; history kept |
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
