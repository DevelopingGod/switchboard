# M3a — Routing brain

Branch `m3a`. Backend first. The Rules UI, rule versioning and the dry-run tester are **M3b**.
Screens: [docs/screens](screens/): `chat-sensitive-*`, `chat-secret-*`, `chat-summary-*`, `settings-*` and `status-*` use fixture data; `footer-quota-*` and `status-live-*` are live, with Groq at a test limit.

## Run it

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build router   # migration 0004
scripts/setup-wsl.sh --pull-models   # detect the GPU -> local-model profile, pull its Ollama models
scripts/doctor.sh                    # profile, models, quota test limits
cd apps/portal && npm run dev        # http://127.0.0.1:3000
```

Evaluate routing on the labelled set (live classifier, no cloud calls):

```bash
docker compose -f deploy/docker-compose.yml run --rm --no-deps -v "$PWD/scripts:/scripts:ro" router python /scripts/eval-routing.py
```

## What changed, in one paragraph per part

1. **Classifier.**
   - Arch-Router-1.5B runs on Ollama, called directly at `/api/chat` (`keep_alive: -1`, temperature 0).
   - The route descriptions live in `config/rules.yaml` → `classifier.routes`. Each route maps to *facts* (`intent`, `size`, `sensitive`).
   - Strong keyword signals decide without a model call: code fences, stack traces, "make an image/video". When both image and video words appear, the classifier decides instead.
   - When the profile has no classifier, Ollama is down, the classifier is slower than 1.5 s, it is reloading, or it answers an unknown route, the M2 keyword heuristics decide. A failure pauses the classifier for 60 s.
   - Every decision records `classifier: {source, route, ms, fallback_reason}`.
   - The model card's prompt is used as is. The Q4 GGUF answers `{'route': 'x'}` with single quotes, and on the CPU sometimes a shortened name (`health`). Both are accepted when they are unambiguous.

2. **Recommender (SPEC §6.4).**
   - Used by `best:<capability>` targets and by the dynamic `explore` alias.
   - Hard filters first: privacy, capability tag, context window, budget, quota, cooldown, connected, and OpenRouter `:free` only.
   - Then the score: `Σ weight·term / Σ weight`, with the terms capability, feedback (smoothed thumbs per task type), latency (median time to first token), success (smoothed), quota headroom, cost and privacy. The weights are in `rules.yaml` → `recommender`.
   - A model with fewer than 5 answers never beats a proven one, unless Settings → Routing → **Explore new models** is on.
   - "Why this?" shows the score, the strongest factors and the runner-up with its score. These are plain strings, so `/chat` gained no bytes for this.

3. **Quota guard.**
   - `providers.yaml` → `limits:` per provider (with per-model overrides and `day_reset_tz`).
   - Counted per minute (sliding) and per day in `quota_usage`, so a restart doesn't reset anything. `x-ratelimit-*` headers from LiteLLM override the counters when they say less is left.
   - **What you see vs what routing uses:** the footer, Status and Metrics show one number per limit: the provider's header where it is fresh (until its reset time, or within the current minute or day when it sends none), otherwise our counter. Routing still takes the higher of the two, and "Why this?" says so when our estimate moved a request while the provider reported less.
   - At 80% of any window, automatic routing moves elsewhere before a 429 can happen. The last 20% is kept for manual picks.
   - An alias near its limit is replaced by its stand-in with the most headroom (`equivalent:` in `providers.yaml`).
   - Cooldowns (429, timeout, credit, 404) are now persisted too.
   - The footer shows the provider closest to its limit ("Groq 72% of today's limit") once one passes 50%. The Status view gives each provider's specific reason and when it ends.

4. **Generic OpenAI-compatible adapter.**
   - A provider can be just a `providers.yaml` entry: `adapter: openai-compatible`, plus optional `models_url` and `models_fields` (dotted paths), `params:` (e.g. an account id, asked for in the key form and filled into `{account_id}` placeholders in URLs) and `limits:`.
   - The proof is `services/router/tests/test_generic_provider.py`. A config dir that differs only by one appended YAML entry goes through key add (validated by fetching its catalog), catalog with custom field names and a bare-array list, LiteLLM credential with the filled-in base URL plus wildcard, routing, a streamed chat, quota counting and the Connections listing.
   - **No new provider was added**, by your decision. GitHub Models (the planned one) was retired on 2026-07-30, and the alternatives are listed under "Future providers" in PROGRESS.

5. **Long threads.**
   - Summarizing starts after a reply once the history reaches 75% of `max_context_tokens`.
   - Everything but the last 6 messages is folded into a running summary: the previous summary plus the newly aged-out turns, never from scratch.
   - It is stored in `threads.summary_json` and sent as one system note ahead of the uncovered messages. In the chat it appears as a collapsible "Summary of earlier messages" note where it takes over.
   - The local tasks model writes it. If that fails, a non-private thread may use `fast`. A private thread never uses a cloud model; it falls back to the M2 trim.

6. **Auto-private and secrets** (your safeguards).
   - **Sensitive messages.** One the classifier reads as health, finance, legal or personal stays on this machine and makes the thread private. The reply shows "Kept local: this looks sensitive (health)" with **Not sensitive — use cloud**, which re-runs the message with normal routing and un-marks the thread; only a thread that auto-detection made private can be switched. Settings → Privacy → **Auto-detect sensitive messages** is on by default.
   - **Pasted secrets.** API keys, tokens, private keys, passwords and card numbers (with a Luhn check) always stay local, with no override. They are masked before storage, and so is a local reply that repeats them (seen live). The message shows "Looks like you pasted a secret — kept local and masked. Consider rotating it." The raw text exists only in memory while that one turn streams, and only the local model sees it.
   - **Where secrets are tested never to appear:** logs, exports (JSON and Markdown), stored messages and requests (the "Why this?" data), titles, the title prompt, summaries, the SSE stream and `prompt_hash`.
   - **Overrides are logged:** `requests.decision_json.sensitive.overridden`. `eval-routing.py --overrides` compares auto-detections with your overrides.

7. **Local-model profiles** (`config/local-models.yaml`).
   - Four profiles: `none`, `small`, `medium`, `large`. hostprobe `/hw` runs one fixed `nvidia-smi` query and reads `/proc/meminfo`; the router picks the profile, and a profile you pick is kept.
   - The profile decides the classifier, the `local`/`private`/`local-code` models and the titles/summaries model.
   - "Detected 4 GB VRAM → small" appears in setup, doctor, the wizard's Connect step, Status, and Settings → Local models (with a picker and a "Pull missing models" action).

8. **Carry-overs.**
   - `explore` is resolved from the live catalog (the best free OpenRouter chat model). A 404 now means "retired": a 6 h cooldown and an immediate catalog refresh for that provider.
   - The Home composer honours "Start new chats as Private".
   - Status rows say exactly what is wrong and until when.

## Routing accuracy

The labelled set is `services/router/tests/routing.jsonl`: 80 prompts, 10 per label. It was written before any tuning and has not changed since. The route descriptions were tuned only against the odd-numbered lines; the even-numbered lines are held out. Run on 2026-11-18 on this machine (small profile, Arch-Router on the GPU):

| method | all | tuning half (odd) | held-out half (even) |
|---|---|---|---|
| **full pipeline** (secrets → pre-filter → Arch-Router → heuristics) | **77/80 = 96.2%** | 40/40 = 100% | **37/40 = 92.5%** |
| Arch-Router alone | 77/80 = 96.2% | 40/40 = 100% | 37/40 = 92.5% |
| keyword heuristics alone | 58/80 = 72.5%* | 32/40 = 80.0% | 26/40 = 65.0% |

\* The heuristics now include the sensitive-message fallback, whose keywords were written after the set existed. Treat that row as optimistic: before it, the same heuristics scored 48/80 = 60%.

The target was ≥ 85%. The full pipeline reaches it, and so does the held-out half alone.

Confusion matrix (full pipeline):

| true \ predicted | writing | code-small | code-large | research | image | video | private | chat |
|---|---|---|---|---|---|---|---|---|
| writing | **9** | · | · | · | 1 | · | · | · |
| code-small | · | **10** | · | · | · | · | · | · |
| code-large | · | · | **10** | · | · | · | · | · |
| research | · | · | · | **10** | · | · | · | · |
| image | · | · | · | · | **10** | · | · | · |
| video | · | · | · | · | · | **10** | · | · |
| private | · | · | · | · | · | · | **8** | 2 |
| chat | · | · | · | · | · | · | · | **10** |

The three misses are all on held-out lines, and none was tuned for:
- line 8: "three catchy captions for an Instagram photo…" goes to image. The pre-filter's "give me … photo".
- line 64: "Here is my bank statement summary…" goes to chat (Arch-Router says `general_chat`). The heuristic fallback would catch it.
- line 70: "My sister told me in confidence she is pregnant…" goes to chat (`general_chat`).

How the result got there:
- The first run scored 60%. The parser rejected Arch-Router's single-quoted answers, so every prompt fell back to the heuristics.
- With the parser fixed and the descriptions untouched, the full pipeline scored 95.0% (76/80).
- The one tuning change: the pre-filter defers to the classifier when both image and video words match (tuning line 43, "Design a YouTube thumbnail for my video"). That brought it to 96.2%.

The classifier on the **CPU** (`classifier_options: { num_gpu: 0 }`) scored 95.0% with a median of 948 ms per call. One shortened route name, `health`, is now accepted as well.

## Measured on this machine: classifier and eviction (small profile, RTX 3050 4 GB)

| | |
|---|---|
| Arch-Router cold load from disk | 2.5 s (58 s the very first time after the pull) |
| warm call | 86–98 ms, p50 136 ms over the 80 prompts |
| after qwen3:4b ran | **evicted**: the next call takes 3.0–3.2 s (reload), then 88 ms |
| `ollama ps` with both requested | only one is loaded: `qwen3:4b` 2236/3371 MiB VRAM or `Arch-Router` 1115/1115 MiB |
| llama3.2:3b (tasks) | also evicts the classifier (2238/2799 MiB) |
| classifier on the CPU (`num_gpu: 0`) | stays loaded next to qwen3:4b on the GPU (after the first settle); 0.9–1.0 s per call |

**What that means.** On 4 GB, Ollama swaps models by memory whatever `keep_alive` says, so the profile's "≤ 2 loaded" can't hold on the GPU. The router does three things about it:
- After the tasks model or a local reply outside a private thread, it reloads the classifier in the background, so the next message usually finds it loaded.
- While a reload runs, it uses the heuristics at once instead of making that message wait 1.5 s.
- The heuristic fallback keeps obviously sensitive first-person messages local. Seen live: right after a private reply, a sertraline question fell back to the heuristics and, before this fix, went to Groq.

Private threads skip the classifier, so they don't trigger a reload. The first message elsewhere after a private chat uses the heuristics.

`OLLAMA_MAX_LOADED_MODELS` doesn't help here: the evictions are by memory, not by count (TROUBLESHOOTING has the note). On 8 GB or more, both stay loaded.

**qwen3:4b with `think: false`** still writes its reasoning into the answer. Titles came out as "Okay, the user wants me to…" and fell back to the first words, and summaries began "We are given…". So the GPU profiles' tasks model is **llama3.2:3b**. Verified live: a clean bullet summary and the title "Exploring Japan's Hidden Gems".

## M3b: classifier and tasks model on the CPU (small profile), before and after

Measured on this machine (RTX 3050 4 GB, 32 GB RAM) with `scripts/measure-local.py` (63 labelled prompts that reach the model; the rest are decided by the pre-filter). Decision record: [ADR 0002](adr/0002-small-profile-cpu-classifier-and-tasks.md).

| | before (classifier on the GPU) | after (classifier and llama3.2:3b on the CPU, qwen3:4b alone on the GPU) |
|---|---|---|
| `ollama ps` after a chat reply and a title | only one model resident (the others evicted) | all three resident: Arch-Router 0 MiB GPU, llama3.2:3b 0 MiB GPU, qwen3:4b 2236 MiB GPU |
| classifier answered by Arch-Router, nothing else running | 0 of 63 (it had been evicted: every call hit the 1.5 s limit, then the 60 s breaker) | 63 of 63 |
| classifier p50 / p95 / max, nothing else running | n/a (evicted) | 897 / 960 / 982 ms |
| classifier p50 / p95 / max **while a title job runs** | n/a (evicted: "classifier is loading") | 906 / 1234 / 1259 ms, 0 of 24 fell back |
| keyword-heuristic fallbacks | 100% after any local reply or title | 0% |
| title job (llama3.2:3b) | median 5.0 s (includes swapping qwen3 out and back) | median 0.9 s |
| accuracy, full pipeline (`eval-routing.py`) | 96.2% (held-out 92.5%) | **96.2% (held-out 92.5%)**, unchanged |

Reading it:
- The privacy gap is closed: a sensitive message is now classified by the model every time, instead of by the keyword heuristics whenever a local model had just run.
- The cost is latency: the classifier takes ~0.9 s on the CPU instead of ~0.1 s on a warm GPU. It still fits the 1.5 s limit with ~270 ms of margin in the worst case measured. **The limit was not raised**: the data doesn't require it. If a slower CPU hits it, the existing breaker and heuristics fallback still apply, and `rules.yaml` → `classifier.timeout_s` is the knob.
- Contention is handled in code, not left to chance: titles and summaries go through one low-priority queue (`app/local_queue.py`). One job at a time, a job doesn't start while a classification is in flight, and the queue is bounded (16). A job that is already running can't be interrupted, which is what the 1234 ms p95 above reflects.
- The accuracy didn't move, as expected: the model and prompt are the same, only the device changed.
- Reproduce: `docker compose -f deploy/docker-compose.yml run --rm --no-deps -v "$PWD/scripts:/scripts:ro" router python /scripts/measure-local.py`. "Before" = the M3a `local-models.yaml` (git `d912ee4`).
- Gemini limits and quota glob matching are in the same change: see ADR 0002.

## Live demos (2026-11-18, real stack)

**Quota guard.** `ROUTER_QUOTA_TEST_LIMITS="groq:openai/gpt-oss-120b=rpd:3"`, four messages:

```
[1] route -> model:fast (Groq · gpt-oss-120b)
[2] route -> model:fast (Groq · gpt-oss-120b)
[3] route -> model:fast (Groq · gpt-oss-120b)
[4] route -> model:groq/openai/gpt-oss-20b (Groq · gpt-oss-20b)
    skipped model:fast: [quota] at 100% of today's limit (3/3); at its limit
    reasons: General chat → default rule | Spread load: Groq · gpt-oss-120b at 100% of today's limit (3/3) | Free tier · Groq does not train on API data
summary.quota.top: Groq, fraction 1.0, window day, resets 2026-11-19T00:00Z    status: limited
Status: provider:groq quota_high until 2026-11-19T00:00Z
```

No request reached the provider's limit, so there was no 429. The 4th went to the stand-in before it. The footer read "Groq 100% of today's limit" (`docs/screens/footer-quota-*`, `status-live-*`). The router was then restarted without the test limit; doctor warns while one is set.

**Explore** (`model:explore`):
```
route -> model:openrouter/baidu/ernie-5.5-flash-preview:free
reasons: You picked this model | Best for the explore alias: score 0.65 (only 0 samples; no proven model available) | Free tier: costs $0
```

**Auto-private and secrets:**
```
>> My blood test came back with high ALT and AST, what could that mean?
   route -> model:local; matched_by=auto_private; classifier arch-router sensitive_health 447 ms
   sensitive: {source: classifier, category: health, overridable: true}
>> why does sk-proj-… give me 401 errors?
   route -> model:local; matched_by=secret; sensitive: {source: secret, kinds: [api_key], overridable: false}
   DB rows containing the key afterwards: 0 (the reply had repeated it; it is stored masked)
```
The override: regenerate with `cloud_override: true` re-ran on Groq and the thread became `private: false`. A thread that is private for any other reason answers 409.

**Long thread** (`model:explore`, five messages of about 1,600 tokens each):
```
[4] context 4805 tokens -> summary covers 2 (llama3.2:3b): "• User: Planning a two-week trip to Japan in April with partner, budget $3000 …"
[5] context 4900 tokens -> summary covers 4 (incremental: previous summary + 2 newly aged-out messages)
title (local): "Exploring Japan's Hidden Gems"
```

## Verified limits and terms (2026-11-18)

- **Groq free plan** (console.groq.com/docs/rate-limits): gpt-oss-120b and 20b at 30 RPM, 1K RPD, 8K TPM, 200K TPD, per model and organisation-wide. Headers: `x-ratelimit-*-requests` = per day, `*-tokens` = per minute. LiteLLM v1.108.8 forwards them, also as `llm_provider-*`.
- **OpenRouter `:free`** (openrouter.ai/docs/api-reference/limits): 20 RPM; 50 RPD, or 1,000 after $10 of credit was ever bought; account-wide. `X-RateLimit-*` comes only on a 429.
- **Gemini free**: per project; the daily quota resets at midnight Pacific. Free numbers are visible only when signed in, so `providers.yaml` holds conservative estimates marked `estimate: true`. Check yours at aistudio.google.com/rate-limit and edit.
- **GitHub Models**: retired on 2026-07-30. **NVIDIA NIM**: trial terms (no production use, no personal, health or financial data, credits). **Hugging Face router**: no free credits. **Cloudflare Workers AI**: 10k Neurons/day free; the URL needs an account id (now supported through `params:`) and there's no OpenAI `/models`; data terms not checked yet.

## Checks

- **Router:** 227 pytest (89 new), ruff clean. New test files: `test_quota`, `test_recommend`, `test_classifier`, `test_summary`, `test_generic_provider`, `test_local_profile`.
- **hostprobe:** 58 unittest (5 new, `/hw`).
- **Portal:**
  - 61 vitest (3 new: footer quota, Status reasons; the recommend test was updated for data-driven per-model pricing).
  - 195 Playwright, including axe in both themes: 8 new in `m3a.spec.ts` and `m15-settings.spec.ts`, covering the auto-private note and override, the masked secret, the summary note with axe, Status reasons, Home private-by-default, the Settings toggles, Local models with axe, and the wizard profile line.
  - Visual baselines regenerated for `settings` and `status` only (both themes). The fixture footer stays below the 50% threshold, so no other page changed.
- **JS budget:** `/chat` 197.7 KB (was 197.3), `/welcome` 197.4, every other route ≤ 193.7. The notes are one lazy chunk with their own strings (`i18n/privacy.ts`); the Settings sections are lazy too.
- **Lighthouse** (mobile): every page ≥ 90 / 99 / 100. `/chat` 91–94 (TBT 290–380 ms), down from 94–95.
- `test:bundle`: the admin token never reaches the browser.
- `doctor.sh`: all green, including the new profile, model and quota-test-limit lines.

## Known and open

- **Visual flake:** the gallery `composer` and `provider-card` (light) sometimes differ in a band at the top in a full run, and pass alone and on a rerun. Seen 2 of 4 full runs.
- `/chat` Lighthouse performance is a little lower (91–94).
- The 4 GB swap: the first message after a private chat, or one sent seconds after a new thread's title, is classified by the heuristics. To keep the classifier always loaded on small GPUs, set `classifier_options: { num_gpu: 0 }` in the `small` profile: it costs about 0.9 s per message and is 95% accurate.
- Gemini's free numbers are estimates; edit them after checking your AI Studio limits.
- The heuristics' sensitive keywords are a safety net, not a classifier: they need a first-person cue and miss subtler cases.
