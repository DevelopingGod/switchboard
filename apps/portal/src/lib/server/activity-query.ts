import "server-only";

// Only these parameters reach the router, each checked for shape.
export const ACTIVITY_PARAMS: Record<string, RegExp> = {
  range: /^(today|7d|30d|custom)$/,
  first: /^\d{4}-\d{2}-\d{2}$/,
  last: /^\d{4}-\d{2}-\d{2}$/,
  tz: /^[A-Za-z0-9_+\-/]{1,64}$/,
  include_demo: /^(true|false)$/,
  kind: /^(chat|media|job|aux|test)$/,
  status: /^(ok|error|failed|stopped|blocked|unavailable|running|queued|needs_approval|waiting_reset|done)$/,
  model: /^[\w.:/@ -]{1,200}$/,
  provider: /^[\w.:/@ -]{1,64}$/,
  rule: /^[\w.:/@ -]{1,64}$/,
  q: /^[^\u0000-\u001f]{1,80}$/,
  cursor: /^[A-Za-z0-9_=-]{1,200}$/,
  limit: /^\d{1,3}$/,
};

export function routerQuery(url: URL): URLSearchParams | string {
  const out = new URLSearchParams();
  for (const [k, re] of Object.entries(ACTIVITY_PARAMS)) {
    const v = url.searchParams.get(k);
    if (v === null || v === "") continue;
    if (!re.test(v)) return `Invalid ${k}`;
    out.set(k, v);
  }
  return out;
}

