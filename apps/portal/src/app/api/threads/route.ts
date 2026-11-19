import { routerGetAdmin } from "@/lib/server/router";
import type { ThreadPage } from "@/lib/router-types";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CURSOR = /^\d{4}-\d\d-\d\dT[\d:.]+(?:[+-]\d\d:\d\d|Z)?_[0-9a-f-]{36}$/;

/**
 * The sidebar's recent chats (M3b): GET /api/threads?limit&cursor&q. Read on the server with the admin
 * token (which never reaches the browser); loopback Host only, like the other route handlers. Every
 * parameter is re-validated here, so nothing but a bounded number, a well-formed cursor and a short
 * search string is ever forwarded to the router.
 */
export async function GET(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return new Response("Forbidden", { status: 403 });
  const u = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number.parseInt(u.searchParams.get("limit") ?? "30", 10) || 30));
  const cursor = u.searchParams.get("cursor");
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (cursor && !CURSOR.test(cursor)) return Response.json({ ok: false, code: "bad_cursor" }, { status: 400 });
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  if (q) qs.set("q", q);
  const r = await routerGetAdmin<ThreadPage>(`/chat/threads?${qs}`);
  return Response.json(r.ok ? { ok: true, data: r.data } : { ok: false, code: r.code ?? "router_down", error: r.error }, {
    status: r.ok ? 200 : 502,
    headers: { "Cache-Control": "no-store" },
  });
}
