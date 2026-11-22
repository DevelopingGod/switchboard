import { forbidden, sameOriginWrite } from "@/lib/server/guard";
import { MAX_UPLOAD_BYTES, upload } from "@/lib/server/attachments";

export const dynamic = "force-dynamic";

/**
 * Upload one file (M2.5): the raw body (`application/octet-stream`) and its name in `X-Filename`, streamed to
 * the router, which decides the type from the bytes and refuses anything that isn't an image, PDF or text.
 * Same-origin only; Content-Length is required and capped before anything is read.
 */
export async function POST(req: Request) {
  if (!sameOriginWrite(req)) return forbidden();
  if ((req.headers.get("content-type") ?? "") !== "application/octet-stream") {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(len) || len <= 0) return Response.json({ error: "The file is empty." }, { status: 411 });
  if (len > MAX_UPLOAD_BYTES) return Response.json({ error: "This file is over the 10 MB limit." }, { status: 413 });
  let name = "";
  try {
    name = decodeURIComponent(req.headers.get("x-filename") ?? "");
  } catch {
    name = "";
  }
  if (!name || name.length > 300 || name.includes("\0")) return Response.json({ error: "invalid file name" }, { status: 400 });
  const out = await upload(req.body, name, len);
  return Response.json(out.body, { status: out.status });
}
