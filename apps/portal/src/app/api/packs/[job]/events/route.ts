import { routerStream } from "@/lib/server/router";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Pack install log (SSE, M4.5a), proxied from the router with the admin token attached on the server.
 * Same-origin only: the Host must be loopback (DNS rebinding) and a browser must say the request
 * is same-origin (cross-site pages can't read it).
 */
export async function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || (site !== null && site !== "same-origin")) {
    return new Response("Forbidden", { status: 403 });
  }
  const { job } = await ctx.params;
  if (!/^[\w-]{1,64}$/.test(job)) return new Response("Not found", { status: 404 });
  const last = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("start") ?? 0);
  return routerStream(`/packs/jobs/${job}/events?start=${Number.isFinite(last) && last > 0 ? Math.floor(last) : 0}`, req.signal);
}
