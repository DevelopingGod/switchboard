/** The Activity log (M2.5): every request, newest first (router `/activity`). Labels only, never content. */
export type ActivityKind = "chat" | "media" | "job" | "aux" | "test";
export const ACTIVITY_KINDS: ActivityKind[] = ["chat", "job", "aux", "test", "media"];
export const ACTIVITY_STATUSES = ["ok", "error", "failed", "stopped", "blocked", "unavailable", "running", "queued", "needs_approval", "waiting_reset", "done"] as const;

export interface ActivityItem {
  id: number;
  at: string;
  kind: ActivityKind;
  /** A thread title, "Private chat", a job name, "Title · …", "Model test: …" */
  label: string;
  private: boolean;
  thread_id: string | null;
  job_id: number | null;
  provider: string | null;
  model: string | null;
  rule: string | null;
  status: string | null;
  latency_ms: number | null;
  cost_usd: number;
  value_usd: number;
  priced: boolean;
  fallbacks: number;
}

export interface ActivityPage {
  range?: { key: string; tz: string; first: string; last: string };
  items: ActivityItem[];
  next: string | null;
}

export interface ActivityOptions {
  model: string[];
  provider: string[];
  rule: string[];
}

export interface ActivityFilters {
  range: string;
  tz: string;
  first?: string;
  last?: string;
  kind?: string;
  status?: string;
  model?: string;
  provider?: string;
  rule?: string;
  q?: string;
}

/** "Why this?" for one row, or where its job lives. */
export interface ActivityDetail {
  id: number;
  kind: ActivityKind;
  job_id?: number | null;
  status?: string | null;
  rule?: string | null;
  model?: string | null;
  latency_ms?: number | null;
  error?: string | null;
  route?: {
    label?: string | null;
    reasons?: string[];
    runner_up?: string | null;
    skipped?: { target: string; label: string; code: string; reason: string }[];
    tokens_in?: number;
    tokens_out?: number;
    context_tokens?: number;
    cost_usd?: number;
    list_price_usd?: number | null;
  } | null;
}

export function activityQuery(f: ActivityFilters, extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) q.set(k, v);
  return q;
}
