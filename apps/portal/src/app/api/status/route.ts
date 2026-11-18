import { routerGet } from "@/lib/server/router";
import type { SystemSummary } from "@/lib/router-types";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Footer data (M1.5): the router's /system/summary, read on the server (no token involved; the
 * endpoint is read-only). Loopback Host only, like the other route handlers (DNS rebinding).
 * Never cached: the footer polls it every 60 s while the page is visible.
 */
export async function GET(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return new Response("Forbidden", { status: 403 });
  const r = await routerGet<SystemSummary>("/system/summary");
  return Response.json(r.ok ? { ok: true, data: r.data } : { ok: false, code: r.code ?? "router_down" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
