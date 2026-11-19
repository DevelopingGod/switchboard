# 0002. Small profile: classifier and tasks model on the CPU

Status: accepted (2026-11-19)

## Context
On a 4 GB GPU Arch-Router (1.1 GB), the chat model (qwen3:4b, 3.4 GB) and the tasks model (llama3.2:3b) can't be
resident together, and Ollama swaps them by memory whatever `keep_alive` says (docs/m3a.md). After any local
reply or title the classifier was evicted, so the next message used the keyword heuristics. The heuristics are
weaker at spotting sensitive content, so a private message could be sent to a cloud model. M3a patched around it
(background reload, first-person heuristics) but didn't remove the cause. Switchboard is open source: the fix must
be a profile setting, not hard-coded to one machine (principle 1, 2).

## Options
1. Keep the classifier on the GPU and reload it after every swap (M3a). Fast when warm (~0.1 s), but a
   privacy-relevant fallback window after every local reply.
2. Classifier and tasks model on the CPU, only the chat model on the GPU. Nothing swaps; the classifier is
   always loaded; ~0.9 s per call; needs ~3.5 GB RAM; CPU contention between the two is possible.
3. Drop the local classifier on small GPUs and use a cloud model. Sends the message text away to decide whether
   it may be sent away. Rejected on privacy grounds.

## Decision
Option 2, for the `small` profile only, as configuration: `classifier_options`, new `tasks_options` and
`tasks_keep_alive` (`config/local-models.yaml`); `max_loaded` counts GPU-resident models only. Medium/large keep
everything on the GPU. To prevent contention, titles and summaries run through one bounded low-priority queue,
one at a time, and wait for any classification in flight (`app/local_queue.py`). The classifier timeout stays
1.5 s because the measured worst case under load was 1.26 s. A CPU-pinned tasks model no longer triggers the
evict/reload workaround.

## Consequences
- Measured (docs/m3a.md): 0% heuristic fallbacks (was 100% after a local reply), accuracy unchanged (96.2%,
  held-out 92.5%), classifier p95 0.96 s alone and 1.23 s during a title job.
- ~270 ms of margin under load: a slower CPU may need a larger `classifier.timeout_s`; the breaker and fallback
  still protect it. A running title job can't be preempted.
- Costs ~3.5 GB of RAM; the `none` profile and machines with little RAM should not use this profile (setup picks
  the profile from VRAM today; a RAM check is a Future item under the local compute optimizer).
- Gemini free limits (same change, 2026-11-19): `providers.yaml` now holds one account's verified numbers.
  Quota limits accept glob model keys (exact id wins, first glob otherwise) and `0` means "no free access", which
  the guard treats as 100% used for automatic routing and manual picks alike. Other accounts may differ; the guard
  also learns from headers and 429s. A key with billing enabled can raise a limit in the YAML.
