# 0006. Local chat answers without a thinking phase; "Think harder" per message

Status: accepted (2026-11-20)

## Context
Private chats run on the local model only. On the owner's machine (RTX 3050, 4 GB) a private reply took about a
minute: the `small` profile's chat model, `qwen3:4b`, reasons before every answer, and with Windows holding part of
the GPU memory only 66% of the loaded model (3.3 GB) fits in GPU memory, so the rest runs on the CPU. Thinking
helps hard questions, but most private messages are short. Switchboard is open source, so the fix has to be a
profile setting, not one machine's model name in code (principles 1, 2).

## Measurements
`scripts/measure-local.py --chat` (new): ten short private questions per candidate, the chat system prompt,
streaming, one warm-up call first, run inside the router image against the real Ollama on the owner's machine
(2026-11-20). "First word" is the time from the request to the first answer token, which is what the reader waits
for. "Reasoning in answer" counts answers that start with the model's reasoning ("Okay, the user…").

| candidate | first word p50 / max | whole answer p50 / max | reasoning in answer | share in GPU |
|---|---|---|---|---|
| `qwen3:4b` through LiteLLM (before) | 31.4 s / 267.5 s | 37.1 s / 281.7 s | 0 / 10 | 66% of 3.3 GB |
| `qwen3:4b` through LiteLLM, `reasoning_effort: none` | 0.3 s / 0.3 s | 34.8 s / 104.6 s | 9 / 10 | 66% |
| `qwen3:4b`, Ollama `think: false` | 0.2 s / 0.3 s | 27.1 s / 38.0 s | 9 / 10 | 66% |
| `qwen3:4b`, thinking (Ollama direct) | 22.8 s / 38.6 s | 32.6 s / 38.6 s | 0 / 10 | 66% |
| **`qwen3:4b-instruct-2507-q4_K_M`** | **0.2 s / 0.2 s** | **7.5 s / 33.5 s** | **0 / 10** | 66% of 3.3 GB |
| `llama3.2:3b` (on the GPU) | 0.1 s / 0.1 s | 7.5 s / 10.1 s | 0 / 10 | 80% of 2.7 GB |
| `qwen3:1.7b`, `think: false` | 0.0 s / 0.1 s | 1.1 s / 3.4 s | 0 / 10 | 100% of 1.6 GB |

After the change (router rebuilt, LiteLLM `local` → the instruct model, `local-think` → `qwen3:4b`), the same
ten questions through the real chat path:

| alias | first word p50 / max | whole answer p50 / max | thought |
|---|---|---|---|
| `local` (every private message) | **0.2 s / 0.2 s** | **7.7 s / 23.6 s** | 0 / 10 |
| `local-think` ("Think harder") | 40.2 s / 203.3 s | 48.9 s / 203.3 s | 10 / 10 |

A dry run of a private message routes to `Ollama · qwen3:4b-instruct-2507-q4_K_M`, and with `think: true` to
`Ollama · qwen3:4b`, under the same `private` rule.

Answer quality was checked by reading the same answers side by side (landlord deposit, will vs trust): the
2507 instruct model gave the most complete, well-structured answers; `llama3.2:3b` was fine but thinner;
`qwen3:1.7b` once wrapped a plain-language answer in a Python code block.

## Options
1. **Turn thinking off on the same model** (`reasoning_effort: none`, which LiteLLM v1.108.8 maps to Ollama
   `think: false`). The first word is instant, but qwen3:4b writes its reasoning into the answer instead (9 of 10),
   so the whole answer is no faster and reads badly. Rejected.
2. **A non-thinking model for local chat, the thinking model on request** (`general` + new `thinker` in each
   profile; per-message "Think harder" picks the `local-think` alias). Same model family and size, answers start
   at once. "Think harder" on a 4 GB GPU swaps models (a few seconds) because the two can't both be loaded.
3. **A smaller model for short questions** (route by length to `qwen3:1.7b`, the rest to a bigger one). Fastest
   and fully on the GPU, but weaker answers, and on 4 GB every switch between the two models is a swap, which
   cancels the gain. Rejected for now; any profile can still set `general: qwen3:1.7b`.

## Decision
Option 2, as configuration:
- `config/local-models.yaml` profiles gain `thinker` (null = the general model). `small`, `medium` and `large` use
  `qwen3:4b-instruct-2507-q4_K_M` as `general` and keep their previous thinking model (`qwen3:4b`, `qwen3:8b`,
  `qwen3:14b`) as `thinker`. `none` (CPU only) keeps `llama3.2:3b` for both.
- A new alias `local-think` follows `thinker` (`providers.yaml`, `local_profile.apply`, reconciled into LiteLLM like
  the other local aliases, and allowed in the private rule).
- Chat API `think: bool` per message (send, edit, regenerate, dry run). When set, the routing engine answers
  local targets (`local`, `private`) through `local-think`; the target, rule and privacy checks are unchanged, and
  cloud answers ignore the flag. The decision log records `think`.
- Portal: a "Think harder" toggle in the composer, shown only while the chat is private (the answer is local), off
  again after every message.
- Thinking text is still streamed and never stored.

## Consequences
- Private replies start in 0.2 s instead of a median 31 s on the owner's machine; whole answers take ~7.5 s.
- Setup and doctor pull one more model per profile (the `thinker`); on `small` that is ~2.5 GB extra disk.
- On small GPUs "Think harder" costs a model swap each way (the router's `max_loaded` eviction handles it).
- The medium and large defaults are not measured on such GPUs; their owners can pick a larger non-thinking model
  in Settings → Local models. Measure with `measure-local.py --chat` before changing a default.
- Cloud models are unaffected; a cloud "think harder" (e.g. `reasoning_effort: high`) is a possible follow-up.
