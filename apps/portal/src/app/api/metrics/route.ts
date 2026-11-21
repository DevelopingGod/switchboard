import { routerGetAdmin } from "@/lib/server/router";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const VIEWS = new Set(["summary", "breakdown", "quotas", "budgets", "top-requests"]);
// Only these parameters reach the router, each checked for shape.
const PARAMS: Record<string, RegExp> = {
  range: /^(today|7d|30d)$/,
  tz: /^[A-Za-z0-9_+\-/]{1,64}$/,
  include_demo: /^(true|false)$/,
  by: /^(provider|model|agent|rule|intent|project|kind)$/,
  cursor: /^[A-Za-z0-9_=-]{1,200}$/,
  limit: /^\d{1,3}$/,
  empty: /^1$/,
};

/**
 * Metrics for the /metrics page's client parts (range switches, Pro sections, paging): read with the admin
 * token on the server, so same-origin only, like the other route handlers. The router caches for 30 s.
 */
export async function GET(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || (site !== null && site !== "same-origin")) return new Response("Forbidden", { status: 403 });
  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "";
  if (!VIEWS.has(view)) return Response.json({ ok: false, error: "Unknown view" }, { status: 400 });
  const out = new URLSearchParams();
  for (const [k, re] of Object.entries(PARAMS)) {
    const v = url.searchParams.get(k);
    if (v === null) continue;
    if (!re.test(v)) return Response.json({ ok: false, error: `Invalid ${k}` }, { status: 400 });
    out.set(k, v);
  }
  const r = await routerGetAdmin<unknown>(`/metrics/${view}?${out}`);
  return Response.json(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code }, {
    status: r.ok ? 200 : r.status >= 400 && r.status < 600 ? r.status : 502,
    headers: { "Cache-Control": "no-store" },
  });
}
