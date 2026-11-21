/** Router /metrics/* shapes (M6, services/router/app/api/metrics.py). */

export type RangeKey = "today" | "7d" | "30d";
export const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d"];
export type BreakdownBy = "provider" | "model" | "agent" | "rule" | "intent" | "project" | "kind";

export interface MetricsRange {
  key: RangeKey | "custom";
  tz: string;
  start: string;
  end: string;
  first: string;
  last: string;
  slot: "hour" | "day";
}

export interface Measures {
  requests: number;
  ok: number;
  errors: number;
  rate_limited: number;
  timeouts: number;
  fallbacks: number;
  tokens_in: number;
  tokens_out: number;
  spent_usd: number;
  value_usd: number;
  unpriced: number;
  jobs_done: number;
  jobs_failed: number;
  thumbs_up: number;
  thumbs_down: number;
}

export interface SeriesPoint extends Measures {
  slot: string;
  p50_ms: number | null;
  p95_ms: number | null;
  ttft_p50_ms: number | null;
}

export interface MetricsTotals extends Measures {
  chats: number;
  demo_requests: number;
  subscriptions_usd: number;
  net_saved_usd: number;
  has_subscriptions: boolean;
}

export interface MetricsSummary {
  range: MetricsRange;
  totals: MetricsTotals;
  series: SeriesPoint[];
  insights: string[];
  include_demo: boolean;
  pending_buckets: number;
}

export interface BreakdownRow extends Measures {
  key: string;
  label: string;
  p50_ms: number | null;
  p95_ms: number | null;
  error_rate: number | null;
  thumbs_up_rate: number | null;
  job_success_rate: number | null;
}

export interface BreakdownPage {
  by: BreakdownBy;
  items: BreakdownRow[];
  next: string | null;
}

export interface QuotaWindow {
  fraction: number;
  window: string;
  kind: string;
  used: number;
  limit: number;
  resets_at: string | null;
  source: string;
  estimate?: boolean;
}

export interface QuotaProvider {
  provider: string;
  name: string;
  model: string | null;
  windows: QuotaWindow[];
  limits_note: string | null;
}

export interface Forecast {
  spent: number;
  cap: number | null;
  resets_at: string;
  fraction: number | null;
  state: "no_cap" | "reached" | "idle" | "on_track" | "will_reach";
  hits_at: string | null;
}

export interface BudgetsView {
  chat: Forecast;
  agents: { agent: string; label: string; today: Forecast; month: Forecast }[];
  note: string;
}

export interface TopRequest {
  id: number;
  at: string;
  kind: string;
  label: string;
  private: boolean;
  provider: string | null;
  model: string | null;
  spent_usd: number;
  value_usd: number;
  tokens: number;
  request_id: number | null;
  job_id: number | null;
  agent: string | null;
  rule_id: string | null;
  intent: string | null;
}

export interface TopRequestsPage {
  items: TopRequest[];
  next: string | null;
}

export interface SubscriptionItem {
  name: string;
  monthly_usd: number;
  start: string;
  end?: string | null;
}
