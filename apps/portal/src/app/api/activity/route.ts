import { routerGetAdmin } from "@/lib/server/router";
import { forbidden, sameSiteRead } from "@/lib/server/guard";
import { routerQuery } from "@/lib/server/activity-query";

export const dynamic = "force-dynamic";

/** Activity log pages and filter options (M2.5), read with the admin token on the server. Same-origin only. */
export async function GET(req: Request) {
  if (!sameSiteRead(req) || req.headers.get("sec-fetch-site") === "none") return forbidden();
  const url = new URL(req.url);
  const q = routerQuery(url);
  if (typeof q === "string") return Response.json({ ok: false, error: q }, { status: 400 });
  const path = url.searchParams.get("view") === "options" ? "/activity/options" : "/activity";
  const r = await routerGetAdmin<unknown>(`${path}?${q}`);
  return Response.json(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }, {
    status: r.ok ? 200 : r.status >= 400 && r.status < 600 ? r.status : 502,
    headers: { "Cache-Control": "no-store" },
  });
}
