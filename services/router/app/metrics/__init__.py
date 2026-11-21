"""Metrics (M6, SPEC §8.6, ADR 0012): one merged view of chat, job and LiteLLM spend.

- `hist`: fixed latency histogram buckets (mergeable across rollup rows) and percentiles.
- `rollup`: recomputes dirty 15-minute buckets of `metrics_15m` from the raw tables.
- `ingest_litellm`: pulls LiteLLM spend logs and inserts the calls the router didn't record (deduped).
- `queries`: the read side used by app.api.metrics (time ranges in the viewer's time zone).
- `subscriptions`, `insights`: honest savings and one-sentence insights.
"""
