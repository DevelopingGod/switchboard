import { routerChatStream } from "@/lib/server/router";
import { forbidden, sameOriginWrite } from "@/lib/server/guard";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET = /^(auto|model:[\w.:/@-]{1,200})$/;
const MAX_TEXT = 32_000;

const bad = (error: string) => Response.json({ error }, { status: 400 });

/**
 * Chat turn (SSE), proxied to the router with the admin token attached on the server.
 * Same checks as the install log, plus Origin because this is a POST that spends tokens:
 *  - Host must be loopback (DNS rebinding),
 *  - Origin must be this same loopback origin (cross-site pages can't POST here),
 *  - Sec-Fetch-Site, when sent, must be same-origin,
 *  - the body must be JSON (no form posts) and is validated again before it reaches the router.
 */
export async function POST(req: Request) {
  if (!sameOriginWrite(req)) return forbidden();
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return bad("invalid body");
  const mode = b.mode;
  const threadId = b.thread_id ?? null;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  const target = typeof b.target === "string" ? b.target : "auto";
  if (mode !== "send" && mode !== "regenerate" && mode !== "edit") return bad("invalid mode");
  if (threadId !== null && (typeof threadId !== "string" || !UUID.test(threadId))) return bad("invalid thread");
  if (mode !== "send" && threadId === null) return bad("thread required");
  // M2.5: uploaded files (send only); a message may be just files.
  const ids = Array.isArray(b.attachment_ids) ? (b.attachment_ids as unknown[]) : [];
  if (ids.length > 20 || !ids.every((i) => typeof i === "string" && UUID.test(i))) return bad("invalid attachments");
  if (mode === "send" ? (!text && ids.length === 0) || text.length > MAX_TEXT : mode === "edit" && (!text || text.length > MAX_TEXT)) {
    return bad("message must be 1–32000 characters");
  }
  if (!TARGET.test(target)) return bad("invalid target");
  const temperature = typeof b.temperature === "number" && b.temperature >= 0 && b.temperature <= 2 ? b.temperature : null;
  const autonomy = Number.isInteger(b.autonomy) && (b.autonomy as number) >= 0 && (b.autonomy as number) <= 3 ? (b.autonomy as number) : null;
  const opts = { target, private: b.private === true, temperature, autonomy, think: b.think === true };

  if (mode === "send") {
    return routerChatStream("/chat/send", { ...opts, thread_id: threadId, text, attachment_ids: ids }, req.signal);
  }
  if (mode === "edit") return routerChatStream(`/chat/threads/${threadId}/edit-last`, { ...opts, text }, req.signal);
  // M3a: "Not sensitive — use cloud" re-runs the last message with normal routing (regenerate only).
  return routerChatStream(`/chat/threads/${threadId}/regenerate`, { ...opts, cloud_override: b.cloud_override === true }, req.signal);
}
