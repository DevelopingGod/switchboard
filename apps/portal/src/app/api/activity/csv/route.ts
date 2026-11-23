import { fixtureMode } from "@/lib/server/router";
import { forbidden, sameSiteRead } from "@/lib/server/guard";
import { activityCsvFixture } from "@/lib/server/metrics-fixtures";
import { routerQuery } from "@/lib/server/activity-query";

export const dynamic = "force-dynamic";

/**
 * The Activity log as CSV (M2.5): every row that matches the filters (up to 50,000), built by the router with
 * formula-injection protection (a cell starting with = + - @ gets a leading apostrophe), streamed through.
 */
export async function GET(req: Request) {
  if (!sameSiteRead(req)) return forbidden();
  const q = routerQuery(new URL(req.url));
  if (typeof q === "string") return new Response(q, { status: 400 });
  const date = new Date().toISOString().slice(0, 10);
  const headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="switchboard-activity-${q.get("range") ?? "7d"}-${date}.csv"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (fixtureMode()) return new Response(activityCsvFixture(), { headers });
  const token = process.env.ROUTER_ADMIN_TOKEN;
  if (!token) return new Response("ROUTER_ADMIN_TOKEN is not set", { status: 500 });
  try {
    const res = await fetch(`${process.env.ROUTER_URL ?? "http://127.0.0.1:8100"}/activity.csv?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) return new Response("Couldn’t export right now.", { status: 502 });
    return new Response(res.body, { headers });
  } catch {
    return new Response("The router is not reachable.", { status: 503 });
  }
}
