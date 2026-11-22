import { forbidden, sameSiteRead } from "@/lib/server/guard";
import { file } from "@/lib/server/attachments";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A small WebP preview of an image attachment. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!sameSiteRead(req)) return forbidden();
  if (!UUID.test(id)) return new Response(null, { status: 404 });
  return file(id, true);
}
