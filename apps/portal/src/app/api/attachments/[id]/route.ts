import { forbidden, sameOriginWrite, sameSiteRead } from "@/lib/server/guard";
import { file, remove } from "@/lib/server/attachments";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The file itself: an image inline (strict CSP, sandbox), anything else as a download (M2.5, ADR 0016). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!sameSiteRead(req)) return forbidden();
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  return file(id, false);
}

/** Remove an upload that wasn't sent (a chip's ×). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!sameOriginWrite(req)) return forbidden();
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  const out = await remove(id);
  return Response.json(out.body, { status: out.status });
}
