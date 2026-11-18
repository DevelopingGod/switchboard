import { routerGetRaw } from "@/lib/server/router";

export const dynamic = "force-dynamic";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Settings → Data → Export (M1.5): downloads every chat as JSON or Markdown. The router needs the
 * admin token for chat history, so the file is fetched here, on the server. Loopback Host only, and
 * same-origin when the browser says where the request came from (another site can't trigger it).
 */
export async function GET(req: Request) {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const site = req.headers.get("sec-fetch-site");
  if (!LOCAL_HOSTS.has(host) || (site !== null && site !== "same-origin" && site !== "none")) {
    return new Response("Forbidden", { status: 403 });
  }
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "md" ? "md" : "json";
  const includePrivate = url.searchParams.get("private") === "1";
  const r = await routerGetRaw(`/chat/export?format=${format}&include_private=${includePrivate}`);
  if (!r) return Response.json({ error: "Couldn’t export right now. Is Switchboard running?" }, { status: 502 });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(r.body, {
    headers: {
      "Content-Type": format === "md" ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="switchboard-chats-${date}.${format === "md" ? "md" : "json"}"`,
      "Cache-Control": "no-store",
    },
  });
}
