# 0017. The Activity log reads `requests`; titles, summaries and model tests get request rows

Status: accepted (2026-11-22, M2.5)

## Context
Metrics → Activity lists every request: chats, jobs, titles and summaries, model tests. Before M2.5 only chats and
jobs had a `requests` row. A title or summary from the local model left no trace at all; one from a cloud model,
and every model test through LiteLLM, appeared only as a `costs` row (kind `aux` / `test`) without status or
latency. Metrics (ADR 0012) counts those calls from their cost rows.

## Options
1. **Write a `requests` row for every title, summary and model test** (`kind` aux / test, status, latency, model,
   `call_id`), and list `requests` only: one keyset index (`created_at, id`), every row has a status and latency.
   Metrics' rollup skips these rows so its totals don't change.
2. Union `requests` with cost rows that have no request: no new writes, but local titles stay invisible, rows
   have no status or latency, and keyset paging over two tables is harder.

## Decision
Option 1 (your choice). The cost of an aux/test call is joined by its LiteLLM call id (`external_id =
'litellm:' || call_id`); a job's by `job_id`; a job row shows the job's own state. Privacy: labels only; a private
chat, and its titles and summaries, read "Private chat"; titles are secret-masked; the title search never matches
a private chat's title (trigram indexes on thread and job titles). The CSV is built by the router with the same
formula-injection guard as the portal's CSV, up to 50,000 rows.

## Consequences
- Request counts in Metrics are unchanged (a test proves it), because the rollup still counts these calls once,
  from costs.
- `requests` grows by one row per title or summary; the same retention as chats will apply when retention lands.
- Model tests that call a provider directly (not through LiteLLM) are listed with no cost, which is true: they are
  1-token pings.
