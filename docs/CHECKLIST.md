# Switchboard — Owner Checklist

> Keep in `docs/CHECKLIST.md`. Tick items as you go. Free-tier limits change often: always confirm the current numbers in each provider's console.

## 1. Connect every supported provider

### API-key providers (Connections → paste key → Test)

| ✔ | Provider | Get key | Role in Switchboard | Free tier (verify) | Privacy |
|---|---|---|---|---|---|
| [x] | Groq | console.groq.com/keys | `fast` (quick chat, titles fallback) | Per-model RPM + daily request caps | No training on API data |
| [x] | Google AI Studio (Gemini) | aistudio.google.com/apikey | `smart-free` (long context, research, writing) | Cut in 2026; per-model RPM/RPD; image quota inconsistent | **May train** (outside EEA/UK/CH) |
| [ ] | Cerebras | cloud.cerebras.ai | 2nd `fast` behind Groq | **One-time free credits, not a renewing tier.** After adding the key, click **Set balance** on its card and enter the starting amount from the Cerebras console; the card shows what is left and routing stops at $0 | Check console |
| [ ] | ~~Mistral~~ (paid only) | console.mistral.ai | `general` (manual pick only) | **The free plan cannot activate API keys.** Skip unless you buy a paid plan; hidden from the free presets and the wizard | **May train** unless opted out (Admin → toggle) |
| [ ] | OpenRouter | openrouter.ai/keys | `explore` + writing fallback (`:free` models only) | ~50 req/day on `:free`; ~1,000/day after a one-time $10 credit. Paid models are used **only if you pick one by hand**; a 402 / credit-limit answer shows as "Credit limit reached" in Why this? | Varies per model |
| [ ] | OpenCode Zen | opencode.ai/auth | `code-free` (free coding models) | Free models rotate | Some free models may use data |
| [ ] | xAI (optional, paid) | console.x.ai | Grok text, Imagine image/video | Paid per token / image / second | Check terms |

### Local
| ✔ | Item | Notes |
|---|---|---|
| [x] | Ollama running on Windows | `qwen3:4b` (local/private/titles), `qwen2.5-coder:3b` (local-code), `llama3.2:3b` (spare) |
| [ ] | Ollama starts with Windows | Ollama app → settings / Startup apps |

### Agent CLIs (Connections → Install → log in from a new Ubuntu tab → Check again)
| ✔ | CLI | Login | Notes |
|---|---|---|---|
| [x] | OpenCode | `opencode auth login` → OpenCode Zen | Verified |
| [ ] | Claude Code | `claude` → browser login with Pro | Official CLI only. Never pass the Pro login to other tools. Install from the portal (Anthropic's native installer, never npm). If a terminal says "native binary not installed", it is running the Windows npm copy (`/mnt/c/.../npm/claude`): run `~/.local/bin/claude` or put `~/.local/bin` first on PATH |
| [ ] | Codex | `codex login` → ChatGPT | Free access is limited/promotional |
| [ ] | Gemini CLI | `gemini` → **Use Gemini API key** (Google sign-in is no longer supported for individuals; key from aistudio.google.com/apikey) | Shares the Gemini API free quota with `smart-free`: CLI use eats into it |
| [ ] | Grok Build | `grok auth login` | Only after buying SuperGrok (planned at M4) |
| [ ] | Tell Claude Code to verify login-status commands for each newly installed CLI | | |

## 2. Make free quotas last

**Habits (start today)**
- [ ] Leave the target on **Auto** — routing spreads load across providers.
- [ ] Use **Private** (local) for trivial or sensitive things — costs no quota.
- [ ] Start a **new chat per topic** — long threads resend history every message.
- [ ] Don't paste huge files into cloud chats; trim to the relevant part.
- [ ] Avoid repeated **Regenerate**; edit the prompt instead.
- [ ] Use `/bulk` for big repetitive jobs (routes to the cheapest free chain).
- [ ] Give 👍/👎 — it teaches the router which models are worth the quota.
- [ ] Optional: one-time $10 OpenRouter credit (raises the `:free` daily cap a lot).

**Settings**
- [ ] `config/rules.yaml`: keep `max_context_tokens: 8000`, `daily_cap_usd: 1.00` (paid models only).
- [ ] Re-run `scripts/gemini-sweep.py` every 2–4 weeks; free models rotate.

**Platform features to build (add to M3 scope)**
- [ ] **Quota guard**: track per-provider usage per minute/day against known free limits; at ~80% route elsewhere *before* hitting 429; reserve headroom for important requests.
- [ ] **Load spreading**: round-robin equivalent free models across providers.
- [ ] **Auto-summarize long threads** to cut resent tokens.
- [ ] **Response cache** for identical prompts (optional).
- [ ] Quota dials on Connections and Metrics (remaining today / resets at).

## 3. Security hygiene
- [ ] Save `SWITCHBOARD_SECRET_KEY` and `LITELLM_SALT_KEY` in a password manager.
- [ ] Remove `GROQ_API_KEY` / `GEMINI_API_KEY` from `deploy/.env` (already imported).
- [ ] Delete any leftover `/tmp/.../env.backup` files.
- [ ] GitHub → Settings → Branches → protect `main` (require PR, no force push).
- [ ] Add keys **only** in Connections — never in chats, commits or screenshots.
- [ ] If a key ever leaks: revoke it in the provider console, then replace it in Connections.

## 4. Daily use (dogfooding)
- [ ] Start the stack: Docker Desktop + Ollama running → `cd ~/switchboard/apps/portal && npm run dev` → http://localhost:3000
- [ ] `scripts/doctor.sh` if anything looks off.
- [ ] Keep an **annoyances list** (what felt slow, wrong route, confusing UI). It drives M1.5 / M3.
- [ ] Before each milestone: no Claude session running while you use git; clean up worktrees (`git worktree list`).

## 5. Adding a new provider in the future

**Goal: OpenAI-compatible providers need YAML only, no code.** (Make this a M3 deliverable: a generic OpenAI-compatible fetcher/adapter.)

1. `config/providers.yaml` — new entry: `kind` (`billing: credits` for one-time credits, `paid: true` for paid-only), `base_url`, `models_endpoint`, `litellm_prefix`, `env_key`, `free_limits`, `privacy`, (CLIs: `bin`, `version_cmd`, `auth_cmd`, `login_hint`, installer).
2. `config/model-tags.yaml` — tag its models (code, fast, reasoning, vision, long-context…).
3. Aliases (optional) — add it to a fallback chain in `providers.yaml` `aliases:`.
4. Only if its API is **not** OpenAI-compatible: add a fetcher in `services/router/app/catalog/fetchers.py` (+ recorded fixture test).
5. CLI agents: add install + version + auth-status entries to hostprobe's allowlist (+ tests); M4 adds the Paperclip adapter.
6. `doctor.sh` check, docs entry, PROGRESS.md line.
7. Prompt for Claude Code: *"Add provider X per docs/CHECKLIST.md §5. Verify its models endpoint, free limits and privacy terms first."*
