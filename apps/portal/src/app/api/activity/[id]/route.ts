import { routerGetAdmin } from "@/lib/server/router";
import { forbidden, sameSiteRead } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

/** "Why this?" for one Activity row (M2.5). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameSiteRead(req) || req.headers.get("sec-fetch-site") === "none") return forbidden();
  const { id } = await ctx.params;
  if (!/^\d{1,18}$/.test(id)) return new Response(null, { status: 404 });
  const r = await routerGetAdmin<unknown>(`/activity/${id}`);
  return Response.json(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }, { status: r.ok ? 200 : r.status || 502 });
}
