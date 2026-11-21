# 0012. Metrics: one costs table, LiteLLM call ids for dedupe, 15-minute rollups

Status: accepted (2026-11-21, M6).

## Context
SPEC §4 and §9: Metrics must merge three sources into one view: the router's own chat costs, Paperclip job costs
(ingested per run since M4a) and LiteLLM spend the router never saw (its own titles and summaries, model tests,
any other LiteLLM client). The same call must never count twice. Demo traffic (`switchboard-demo`) is left out by
default. Reads must stay cheap as history grows (no full-table scans), and "today" is the viewer's local day.

## Decisions
1. **Dedupe by a caller-chosen id.** Every router call to LiteLLM sends `x-litellm-call-id: sb-<kind>-<hex>`
   (`chat`, `aux`, `test`). LiteLLM v1.108.8 stores it as the spend log's `litellm_call_id` (verified live,
   docs/m6.md). A chat turn's `costs` row uses `external_id = litellm:<call id>`; the spend-log ingester inserts
   every successful log with the same key and `ON CONFLICT DO NOTHING`. Logs without an `sb-` id are "external".
   - Chat logs younger than 15 minutes are left for a later run, so the router's own insert (which has no
     `ON CONFLICT`) always comes first; after that the ingester only fills a turn the router lost (a crash).
   - Logs from before ingest first ran (`metrics.litellm_start`) are skipped unless they carry an `sb-` id: the
     router's pre-M6 chat calls had no id and are already in `costs`. History before M6 is therefore not imported.
     The first live run without this rule counted 94 such calls twice; they were removed and the rule added.
   - Alternatives: matching by (model, time, tokens) is fuzzy; reading LiteLLM's database directly skips the thin
     adapter and its contract test.
2. **`costs.kind`** (chat | media | job | aux | test | external) and **`costs.job_id`** (backfilled from the run id in
   `job_events`) make the table self-describing; agent budgets now join costs by job id.
3. **15-minute rollups** (`metrics_15m`), not hourly: 15 minutes lines up with every UTC offset in use (+5:30
   India, +5:45 Nepal, −3:30 Newfoundland), so local days and hours are exact. Dimensions: kind, provider, model,
   agent, rule, intent, project, demo; measures include counts, tokens, money and fixed-edge latency histograms
   (mergeable; p50/p95 are interpolated within one bucket).
4. **Dirty buckets via triggers into an append-only log** (`metrics_dirty`). Triggers on `costs`, `requests`, `jobs`
   (insert, update, delete: old and new bucket) and `messages.feedback` append the bucket. The worker recomputes
   each dirty bucket from the raw rows (delete + insert) under an advisory lock and deletes exactly the marks it
   read. No writer has to remember to mark anything, marking never takes a lock (an upsert would serialise writers
   and risk deadlocks), and a mark committed during a run stays for the next one.
   - Alternative: high-water marks per table. Misses updates (feedback, a job finishing days later, deletes).
5. **Reads**: `metrics_15m` by `bucket_start` (indexed) grouped in the viewer's time zone; the per-request list reads
   `costs` by `created_at` with keyset paging. Answers are cached 30 s per parameter set (bounded LRU).
6. **Money words**: *spent* = real money (`cost_usd`); *value at API prices* = list price of everything (when a
   source reports none, what was paid); *net saved* = value − subscription fees for the range (Settings →
   Subscriptions, pro-rated per calendar month) − spent. Insights only ever use net saved.

## Consequences
- One extra trigger insert per write to the four tables; the worker drains them every 60 s (cost O(new rows)).
- `python -m app.metrics.rollup --rebuild --since <date>` recomputes any range (repairs, or after a rollup change).
- `metrics_dirty` rows accumulate only if the worker stops; Metrics shows "recent activity is still being added".
- Only the main router ingests LiteLLM logs (`ROUTER_SYNC_ENABLED`): the demo router shares LiteLLM, not the
  database, and its calls are tagged `switchboard-demo` in `end_user` and `request_tags`.
