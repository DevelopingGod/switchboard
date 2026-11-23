import "server-only";
import { SUBSCRIPTIONS } from "./jobs-fixtures";
import type { Result } from "./router";
import type {
  BreakdownBy,
  BreakdownPage,
  BreakdownRow,
  BudgetsView,
  Measures,
  MetricsSummary,
  QuotaProvider,
  SeriesPoint,
  SubscriptionItem,
  TopRequestsPage,
} from "../metrics-types";

/**
 * PORTAL_DATA=fixture: deterministic Metrics data (M6) for tests and screenshots. Dates are fixed
 * (21 Nov 2026) so visual baselines never drift with the calendar. `?empty=1` on the summary path (set by
 * the page for `?fixture=empty`) returns a range with no activity.
 */

const DAY = "2026-11-21";
let subs: SubscriptionItem[] = [{ name: "Claude Pro", monthly_usd: 20, start: "2026-11-01", end: null }];

function rnd(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const zero = (): Measures => ({
  requests: 0,
  ok: 0,
  errors: 0,
  rate_limited: 0,
  timeouts: 0,
  fallbacks: 0,
  tokens_in: 0,
  tokens_out: 0,
  spent_usd: 0,
  value_usd: 0,
  unpriced: 0,
  jobs_done: 0,
  jobs_failed: 0,
  thumbs_up: 0,
  thumbs_down: 0,
});

function series(range: string, empty: boolean): SeriesPoint[] {
  const r = rnd(range === "today" ? 7 : range === "7d" ? 11 : 13);
  const hour = range === "today";
  const n = hour ? 13 : range === "7d" ? 7 : 30; // today: 00:00..12:00 (fixture "now" is noon)
  const out: SeriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    let slot: string;
    if (hour) slot = `${DAY}T${String(i).padStart(2, "0")}:00:00`;
    else {
      const d = new Date(Date.UTC(2026, 10, 21 - (n - 1 - i)));
      slot = `${d.toISOString().slice(0, 10)}T00:00:00`;
    }
    const busy = empty ? 0 : hour ? (i >= 8 ? 1 : i < 2 ? 0.2 : 0) : 0.4 + r();
    const req = Math.round(busy * (hour ? 9 : 34) * (0.6 + r()));
    const errs = req ? Math.round(r() * 2.4) : 0;
    const p = { ...zero(), requests: req, ok: req - errs, errors: errs };
    p.rate_limited = req ? Math.round(r() * 1.6) : 0;
    p.timeouts = req && r() > 0.6 ? 1 : 0;
    p.fallbacks = p.rate_limited + p.timeouts;
    p.tokens_in = req * 1800;
    p.tokens_out = req * 320;
    p.spent_usd = req ? Math.round(r() * (hour ? 4 : 18)) / 100 : 0;
    p.value_usd = req ? p.spent_usd + Math.round(req * (hour ? 4 : 5) * (0.5 + r())) / 100 : 0;
    p.jobs_done = req && r() > (hour ? 0.8 : 0.5) ? 1 : 0;
    p.thumbs_up = req ? Math.round(r() * 2) : 0;
    p.thumbs_down = req && r() > 0.8 ? 1 : 0;
    const lat = req ? 900 + Math.round(r() * 1400) : null;
    out.push({ ...p, slot, p50_ms: lat, p95_ms: lat ? lat * 3 + Math.round(r() * 2000) : null, ttft_p50_ms: lat ? Math.round(lat * 0.3) : null });
  }
  return out;
}

function sum(points: Measures[]): Measures {
  const t = zero();
  for (const p of points) for (const k of Object.keys(t) as (keyof Measures)[]) t[k] += p[k];
  t.spent_usd = Math.round(t.spent_usd * 100) / 100;
  t.value_usd = Math.round(t.value_usd * 100) / 100;
  return t;
}

const DAYS: Record<string, number> = { today: 1, "7d": 7, "30d": 30 };

function summary(range: string, tz: string, empty: boolean, demo: boolean): MetricsSummary {
  const s = series(range, empty);
  const t = sum(s);
  const days = DAYS[range] ?? 7;
  const fees = subs.reduce((a, x) => a + (x.monthly_usd * days) / 30, 0);
  const net = Math.round((t.value_usd - fees - t.spent_usd) * 100) / 100;
  const first = range === "today" ? DAY : new Date(Date.UTC(2026, 10, 22 - days)).toISOString().slice(0, 10);
  return {
    range: { key: range as MetricsSummary["range"]["key"], tz, start: `${first}T00:00:00Z`, end: `${DAY}T12:00:00Z`, first, last: DAY, slot: range === "today" ? "hour" : "day" },
    totals: {
      ...t,
      requests: t.requests + (demo ? 6 : 0),
      chats: Math.round(t.requests * 0.86),
      demo_requests: demo ? 0 : empty ? 0 : 6,
      subscriptions_usd: Math.round(fees * 100) / 100,
      net_saved_usd: net,
      has_subscriptions: subs.length > 0,
    },
    series: s,
    insights: empty
      ? []
      : [
          "Groq handled 62% of your chats for free.",
          net >= 0
            ? `You're $${net.toFixed(2)} ahead: $${t.value_usd.toFixed(2)} of use at API prices, minus $${fees.toFixed(2)} of subscriptions and $${t.spent_usd.toFixed(2)} spent.`
            : `Subscriptions cost more than they saved this period: $${fees.toFixed(2)} in fees and $${t.spent_usd.toFixed(2)} spent, against $${t.value_usd.toFixed(2)} of use at API prices.`,
          `Providers returned ${t.rate_limited} rate limits (429) and ${t.timeouts} timeouts; ${t.fallbacks} times another model answered instead.`,
          ...(range === "today" ? ["At this rate you'll reach your daily cap ($1.00) at 18:00."] : []),
        ].slice(0, 4),
    include_demo: demo,
    pending_buckets: 0,
  };
}

const ROWS: Record<BreakdownBy, [string, string][]> = {
  provider: [["groq", "Groq"], ["gemini", "Google Gemini"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["cerebras", "Cerebras"]],
  model: [
    ["groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-120b"],
    ["gemini/gemini-3.5-flash", "gemini/gemini-3.5-flash"],
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["ollama_chat/qwen3:4b-instruct-2507-q4_K_M", "ollama_chat/qwen3:4b-instruct-2507-q4_K_M"],
    ["cerebras/gpt-oss-120b", "cerebras/gpt-oss-120b"],
    ["groq/llama-4-scout", "groq/llama-4-scout"],
  ],
  agent: [["claude-code", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"]],
  rule: [["quick", "quick"], ["code", "code"], ["write", "write"], ["private", "private"]],
  intent: [["chat", "chat"], ["code", "code"], ["writing", "writing"], ["research", "research"]],
  project: [["1", "switchboard-playground"], ["2", "blog"]],
  kind: [["chat", "Chat"], ["job", "Agent jobs"], ["aux", "Titles and summaries"], ["external", "Other LiteLLM clients"]],
};

function breakdown(by: BreakdownBy, range: string, limit: number, offset: number): BreakdownPage {
  const r = rnd(by.length * 31 + (DAYS[range] ?? 7));
  const scale = DAYS[range] ?? 7;
  const all: BreakdownRow[] = ROWS[by].map(([key, label], i) => {
    const agentish = by === "agent" || by === "project";
    const req = agentish ? 0 : Math.max(1, Math.round((40 - i * 7) * scale * (0.3 + r())));
    const done = agentish || by === "kind" ? Math.round((4 - i) * Math.min(scale, 7) * 0.5 * (0.5 + r())) : 0;
    const failed = done ? Math.round(r() * 2) : 0;
    const up = req ? Math.round(req * 0.08 * r() + 1) : 0;
    const down = req && i % 2 ? Math.round(r() * 2) : 0;
    const rl = req ? Math.round(r() * 3 * (i === 0 ? 2 : 1)) : 0;
    // Free tiers, local models and subscription agents cost nothing; only paid providers/models spend.
    const free = /groq|gemini|ollama|cerebras|anthropic|claude|codex|opencode|private|quick|chat|aux/.test(key);
    const spent = free ? 0 : Math.round(r() * 30 * (i + 1)) / 100;
    const value = spent + Math.round((req + done * 30) * 2 * (0.5 + r())) / 100;
    const p50 = req ? 700 + i * 400 + Math.round(r() * 300) : null;
    return {
      ...zero(),
      key,
      label,
      requests: req,
      ok: req - (req ? 1 : 0),
      errors: req ? 1 : 0,
      rate_limited: rl,
      timeouts: req && i === 1 ? 1 : 0,
      fallbacks: rl + (req && i === 1 ? 1 : 0),
      tokens_in: req * 1900,
      tokens_out: req * 300,
      spent_usd: spent,
      value_usd: value,
      jobs_done: done,
      jobs_failed: failed,
      thumbs_up: up,
      thumbs_down: down,
      p50_ms: p50,
      p95_ms: p50 ? p50 * 3 : null,
      error_rate: req ? 1 / req : null,
      thumbs_up_rate: up + down ? up / (up + down) : null,
      job_success_rate: done + failed ? done / (done + failed) : null,
    };
  });
  all.sort((a, b) => b.value_usd - a.value_usd);
  const items = all.slice(offset, offset + limit);
  return { by, items, next: offset + limit < all.length ? Buffer.from(JSON.stringify({ o: offset + limit })).toString("base64url") : null };
}

const QUOTAS: QuotaProvider[] = [
  {
    provider: "groq",
    name: "Groq",
    model: "openai/gpt-oss-120b",
    limits_note: "1,000 requests/day, 30/min",
    windows: [
      { fraction: 0.62, window: "day", kind: "requests", used: 620, limit: 1000, resets_at: `${DAY}T18:30:00Z`, source: "counter" },
      { fraction: 0.2, window: "minute", kind: "requests", used: 6, limit: 30, resets_at: `${DAY}T12:01:00Z`, source: "headers" },
    ],
  },
  {
    provider: "gemini",
    name: "Google Gemini",
    model: "gemini-3.5-flash",
    limits_note: "250 requests/day",
    windows: [{ fraction: 0.18, window: "day", kind: "requests", used: 45, limit: 250, resets_at: `${DAY}T08:00:00Z`, source: "counter", estimate: true }],
  },
  {
    provider: "cerebras",
    name: "Cerebras",
    model: null,
    limits_note: "1M tokens/day",
    windows: [{ fraction: 0.91, window: "day", kind: "tokens", used: 910_000, limit: 1_000_000, resets_at: `${DAY}T23:59:00Z`, source: "counter" }],
  },
];

const BUDGETS: BudgetsView = {
  chat: { spent: 0.42, cap: 1, resets_at: "2026-11-22T00:00:00Z", fraction: 0.42, state: "will_reach", hits_at: `${DAY}T12:30:00Z` },
  agents: [
    {
      agent: "claude-code",
      label: "Claude Code",
      today: { spent: 1.2, cap: 10, resets_at: "2026-11-22T00:00:00Z", fraction: 0.12, state: "on_track", hits_at: null },
      month: { spent: 14.3, cap: 50, resets_at: "2026-12-01T00:00:00Z", fraction: 0.286, state: "on_track", hits_at: null },
    },
    {
      agent: "codex",
      label: "Codex",
      today: { spent: 0, cap: 10, resets_at: "2026-11-22T00:00:00Z", fraction: 0, state: "idle", hits_at: null },
      month: { spent: 0, cap: null, resets_at: "2026-12-01T00:00:00Z", fraction: null, state: "no_cap", hits_at: null },
    },
  ],
  note: "Agent budgets count list price; the chat cap counts real money.",
};

function top(limit: number, offset: number): TopRequestsPage {
  const base = [
    { label: "Fix the flaky login test", kind: "job", agent: "claude-code", provider: "anthropic", model: "claude-sonnet-5-5", value: 0.412, spent: 0 },
    { label: "Refactor the billing module", kind: "job", agent: "codex", provider: "openai", model: "gpt-5.3-codex", value: 0.31, spent: 0 },
    { label: "Explain this stack trace", kind: "chat", provider: "groq", model: "groq/openai/gpt-oss-120b", value: 0.021, spent: 0 },
    { label: "Private chat", kind: "chat", provider: "ollama", model: "ollama_chat/qwen3:4b-instruct-2507-q4_K_M", value: 0.018, spent: 0, private: true },
    { label: "Draft the launch post", kind: "chat", provider: "gemini", model: "gemini/gemini-3.5-flash", value: 0.016, spent: 0 },
    { label: "=SUM(A1:A3) budget sheet", kind: "chat", provider: "mistral", model: "mistral/mistral-small", value: 0.012, spent: 0.012 },
    { label: "Title or summary", kind: "aux", provider: "groq", model: "groq/openai/gpt-oss-120b", value: 0.0004, spent: 0 },
  ];
  const items = base.slice(offset, offset + limit).map((b, i) => ({
    id: 900 - offset - i,
    at: `${DAY}T${String(11 - offset - i).padStart(2, "0")}:15:00Z`,
    kind: b.kind,
    label: b.label,
    private: Boolean((b as { private?: boolean }).private),
    provider: b.provider,
    model: b.model,
    spent_usd: b.spent,
    value_usd: b.value,
    tokens: 4200 - (offset + i) * 300,
    request_id: b.kind === "chat" ? 500 - offset - i : null,
    job_id: b.kind === "job" ? 12 - offset - i : null,
    agent: (b as { agent?: string }).agent ?? null,
    rule_id: b.kind === "chat" ? "quick" : null,
    intent: b.kind === "chat" ? "chat" : null,
  }));
  const more = offset + limit < base.length;
  return { items, next: more ? Buffer.from(JSON.stringify({ v: 0, id: offset + limit })).toString("base64url") : null };
}

export function handle<T>(method: string, path: string, body: unknown): Result<T> {
  const url = new URL(path, "http://fixture");
  const q = url.searchParams;
  const p = url.pathname;
  const range = q.get("range") ?? "7d";
  const ok = (data: unknown): Result<T> => ({ ok: true, data: data as T });
  if (p.startsWith("/activity")) return activity<T>(p, q);
  if (p === "/settings/subscriptions") {
    if (method === "PUT") subs = ((body as { items?: SubscriptionItem[] }) ?? {}).items ?? [];
    return ok({ items: subs });
  }
  if (method !== "GET") return { ok: false, status: 405, error: "Method not allowed" };
  if (p === "/metrics/summary") {
    if (range === "custom") {
      // M6.5: a custom range: the 30-day fixture cut to first..last (the fixture "today" is 2026-11-21).
      const first = q.get("first") ?? "", last = q.get("last") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) return { ok: false, status: 400, error: "custom range needs first ≤ last (YYYY-MM-DD)" };
      const base = summary("30d", q.get("tz") ?? "UTC", q.get("empty") === "1", q.get("include_demo") === "true");
      const keep = base.series.filter((pt) => pt.slot.slice(0, 10) >= first && pt.slot.slice(0, 10) <= last);
      return ok({ ...base, range: { ...base.range, key: "custom", first, last, start: `${first}T00:00:00Z` }, series: keep.length ? keep : base.series.slice(-1) });
    }
    return ok(summary(range, q.get("tz") ?? "UTC", q.get("empty") === "1", q.get("include_demo") === "true"));
  }
  if (p === "/metrics/breakdown") {
    const off = q.get("cursor") ? JSON.parse(Buffer.from(q.get("cursor")!, "base64url").toString()).o : 0;
    return ok(breakdown((q.get("by") ?? "provider") as BreakdownBy, range, Number(q.get("limit") ?? 25), off));
  }
  if (p === "/metrics/quotas") return ok({ providers: QUOTAS, subscriptions: SUBSCRIPTIONS() });
  if (p === "/metrics/budgets") return ok(BUDGETS);
  if (p === "/metrics/top-requests") {
    const off = q.get("cursor") ? JSON.parse(Buffer.from(q.get("cursor")!, "base64url").toString()).id : 0;
    return ok(top(Number(q.get("limit") ?? 20), off));
  }
  return { ok: false, status: 404, error: `No fixture for ${p}` };
}


// --- M2.5 Activity log -----------------------------------------------------------------------------------
type ActRow = import("@/lib/activity-types").ActivityItem;
const ACT_NOW = Date.parse("2026-11-21T16:30:00Z");
const ACT: ActRow[] = (() => {
  const rows: Omit<ActRow, "id" | "at">[] = [
    { kind: "chat", label: "Why is the sky blue?", private: false, thread_id: "6f1c2a10-0000-4000-8000-000000000001", job_id: null, provider: "groq", model: "groq/openai/gpt-oss-120b", rule: "default", status: "ok", latency_ms: 747, cost_usd: 0, value_usd: 0.000066, priced: true, fallbacks: 0 },
    { kind: "aux", label: "Title · Why is the sky blue?", private: false, thread_id: "6f1c2a10-0000-4000-8000-000000000001", job_id: null, provider: "ollama", model: "ollama/llama3.2:3b", rule: null, status: "ok", latency_ms: 610, cost_usd: 0, value_usd: 0, priced: false, fallbacks: 0 },
    { kind: "chat", label: "Private chat", private: true, thread_id: null, job_id: null, provider: "ollama", model: "ollama_chat/qwen3:4b-instruct-2507-q4_K_M", rule: "private", status: "ok", latency_ms: 900, cost_usd: 0, value_usd: 0, priced: false, fallbacks: 0 },
    { kind: "job", label: "Fix the failing tests in api/", private: false, thread_id: null, job_id: 14, provider: "anthropic", model: "claude-code", rule: "code-heavy", status: "running", latency_ms: null, cost_usd: 0, value_usd: 0.412, priced: true, fallbacks: 0 },
    { kind: "chat", label: "What does this chart show?", private: false, thread_id: "6f1c2a10-0000-4000-8000-000000000002", job_id: null, provider: "gemini", model: "gemini/gemini-3.1-flash-lite", rule: "vision", status: "ok", latency_ms: 1840, cost_usd: 0, value_usd: 0.00041, priced: true, fallbacks: 0 },
    { kind: "chat", label: "=HYPERLINK(\"x\") budget plan", private: false, thread_id: "6f1c2a10-0000-4000-8000-000000000003", job_id: null, provider: "gemini", model: "gemini/gemini-3.1-flash-lite", rule: "default", status: "ok", latency_ms: 2210, cost_usd: 0, value_usd: 0.00012, priced: true, fallbacks: 1 },
    { kind: "test", label: "Model test: groq/openai/gpt-oss-20b", private: false, thread_id: null, job_id: null, provider: "groq", model: "groq/openai/gpt-oss-20b", rule: null, status: "ok", latency_ms: 338, cost_usd: 0, value_usd: 0.000002, priced: true, fallbacks: 0 },
    { kind: "chat", label: "Summarize the Q3 report", private: false, thread_id: "6f1c2a10-0000-4000-8000-000000000004", job_id: null, provider: "gemini", model: "gemini/gemini-3.1-flash-lite", rule: "long-document", status: "error", latency_ms: 30000, cost_usd: 0, value_usd: 0, priced: false, fallbacks: 2 },
  ];
  const out: ActRow[] = [];
  for (let i = 0; i < 60; i++) {
    const r = rows[i % rows.length];
    out.push({ ...r, id: 1000 - i, at: new Date(ACT_NOW - i * 47 * 60_000).toISOString() });
  }
  return out;
})();

function activity<T>(p: string, q: URLSearchParams): Result<T> {
  const ok = (data: unknown): Result<T> => ({ ok: true, data: data as T });
  if (p === "/activity/options") {
    const uniq = (k: "model" | "provider" | "rule") => [...new Set(ACT.map((r) => r[k]).filter((v): v is string => !!v))].sort();
    return ok({ model: uniq("model"), provider: uniq("provider"), rule: uniq("rule"), kinds: ["chat", "media", "job", "aux", "test"] });
  }
  const m = p.match(/^\/activity\/(\d+)$/);
  if (m) {
    const r = ACT.find((x) => x.id === Number(m[1]));
    if (!r) return { ok: false, status: 404, error: "request not found" };
    if (r.kind === "job") return ok({ id: r.id, kind: "job", job_id: r.job_id });
    return ok({
      id: r.id,
      kind: r.kind,
      status: r.status,
      rule: r.rule,
      model: r.model,
      latency_ms: r.latency_ms,
      error: r.status === "error" ? "No answer within 30 s" : null,
      route: r.kind === "chat"
        ? {
            label: r.provider === "gemini" ? "Google AI Studio · gemini-3.1-flash-lite" : "Groq · gpt-oss-120b",
            reasons: r.rule === "vision" ? ["Needs vision: this message has an image", "Best for “vision”: score 0.81", "Free tier (may train on your data)"] : ["General chat → default rule", "First choice of rule “default”", "Free tier · Groq does not train on API data"],
            runner_up: null,
            skipped: r.fallbacks ? [{ target: "model:fast", label: "Groq · gpt-oss-120b", code: "rate_limited", reason: "Rate limited (429)" }] : [],
            tokens_in: 117,
            tokens_out: 81,
            cost_usd: 0,
            list_price_usd: r.value_usd,
          }
        : null,
    });
  }
  const range = q.get("range") ?? "7d";
  const days = range === "today" ? 1 : range === "30d" ? 30 : 7;
  let rows = ACT.filter((r) => ACT_NOW - Date.parse(r.at) < days * 86_400_000);
  for (const k of ["kind", "status", "model", "provider", "rule"] as const) {
    const v = q.get(k);
    if (v) rows = rows.filter((r) => r[k] === v);
  }
  const term = (q.get("q") ?? "").toLowerCase();
  if (term) rows = rows.filter((r) => !r.private && r.label.toLowerCase().includes(term));
  const after = q.get("cursor") ? JSON.parse(Buffer.from(q.get("cursor")!, "base64url").toString()).id : Infinity;
  rows = rows.filter((r) => r.id < after);
  const limit = Number(q.get("limit") ?? 50);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? Buffer.from(JSON.stringify({ id: page.at(-1)!.id })).toString("base64url") : null;
  return ok({ range: { key: range, tz: q.get("tz") ?? "UTC", first: "2026-11-15", last: "2026-11-21" }, items: page, next });
}

/** The Activity CSV in fixture mode: the same formula guard as the router's. */
export function activityCsvFixture(): string {
  const risky = /^[=+\-@\t\r]/;
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    const g = typeof v === "number" ? s : risky.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
  };
  const cols = ["at", "kind", "label", "provider", "model", "rule", "status", "latency_ms", "cost_usd", "value_usd", "fallbacks", "job_id"] as const;
  return "\ufeff" + [cols.join(","), ...ACT.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
