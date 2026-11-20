import { routerGetAdmin } from "@/lib/server/router";
import type { JobCounts, JobsPage } from "@/lib/router-types";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * What the sidebar's Jobs badge and the job toasts need (M4b): how many jobs wait for you, and the newest
 * jobs' states (the watcher compares them with what it saw last time). Read with the admin token on the
 * server, so same-origin only, like the other route handlers. Never cached; polled while the page is
 * visible.
 */
export async function GET(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || (site !== null && site !== "same-origin")) return new Response("Forbidden", { status: 403 });
  const [counts, recent] = await Promise.all([routerGetAdmin<JobCounts>("/jobs/counts"), routerGetAdmin<JobsPage>("/jobs?limit=20")]);
  if (!counts.ok || !recent.ok) return Response.json({ ok: false }, { headers: { "Cache-Control": "no-store" } });
  return Response.json(
    {
      ok: true,
      needs_you: counts.data.needs_you,
      jobs: recent.data.jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, gate: j.gate, error: j.error })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
