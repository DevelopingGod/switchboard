import { forbidden, sameOriginWrite } from "@/lib/server/guard";
import { estimate } from "@/lib/server/attachments";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET = /^(auto|model:[\w.:/@-]{1,200})$/;

/** Tokens the attachments will cost on the model that would answer (M2.5), shown before sending. */
export async function POST(req: Request) {
  if (!sameOriginWrite(req)) return forbidden();
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return new Response(null, { status: 415 });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const ids = Array.isArray(b?.attachment_ids) ? (b.attachment_ids as unknown[]) : [];
  if (ids.length > 20 || !ids.every((i) => typeof i === "string" && UUID.test(i))) return Response.json({ error: "invalid ids" }, { status: 400 });
  const target = typeof b?.target === "string" && TARGET.test(b.target) ? b.target : "auto";
  const text = typeof b?.text === "string" ? b.text.slice(0, 32_000) : "";
  const out = await estimate({ attachment_ids: ids, target, text, private: b?.private === true });
  return Response.json(out.body, { status: out.status });
}
