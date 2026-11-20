import { routerStream } from "@/lib/server/router";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An agent job's live stream (SSE: `job` snapshots, the current run's `log` lines, `end`), proxied from the
 * router with the admin token attached on the server. Same-origin only, like the install log: the Host must
 * be loopback (DNS rebinding) and a browser must say the request is same-origin. `Last-Event-ID` (sent by
 * EventSource on reconnect) is passed on, so the log resumes at the byte offset it reached.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || (site !== null && site !== "same-origin")) {
    return new Response("Forbidden", { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^\d{1,12}$/.test(id)) return new Response("Not found", { status: 404 });
  const last = req.headers.get("last-event-id");
  const resume = last && /^log:[\w-]{1,64}:\d{1,15}$/.test(last) ? last : null;
  return routerStream(`/jobs/${id}/events`, req.signal, resume);
}
