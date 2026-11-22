import "server-only";
import type { AttachmentEstimate, AttachmentInfo } from "@/lib/router-types";
import { fixtureMode } from "./router";
import * as fx from "./attachments-fixtures";

/**
 * Attachments (M2.5) between the browser and the router. Uploads stream the raw body through (no buffering
 * here beyond what fetch needs); files come back with headers re-checked so nothing but a raster image is
 * ever rendered on the portal's origin (ADR 0016).
 */

const routerUrl = () => process.env.ROUTER_URL ?? "http://127.0.0.1:8100";
const auth = (): Record<string, string> => {
  const t = process.env.ROUTER_ADMIN_TOKEN;
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 + 64 * 1024; // the router's limit is the real one
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const INLINE_IMAGE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

type Out = { status: number; body: unknown };

function detailOf(j: unknown, fallback: string): string {
  const d = (j as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  return fallback;
}

export async function upload(body: ReadableStream<Uint8Array> | null, name: string, length: number | null): Promise<Out> {
  if (fixtureMode()) return fx.upload(body, name);
  try {
    const res = await fetch(routerUrl() + "/attachments", {
      method: "POST",
      headers: {
        ...auth(),
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(name),
        ...(length !== null ? { "Content-Length": String(length) } : {}),
      },
      body,
      // @ts-expect-error -- Node's fetch needs this to stream a request body
      duplex: "half",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { status: res.status, body: { error: detailOf(j, "The file couldn't be attached.") } };
    return { status: 200, body: j as AttachmentInfo };
  } catch {
    return { status: 503, body: { error: "The router is not reachable. Is the stack running? (scripts/doctor.sh)" } };
  }
}

export async function remove(id: string): Promise<Out> {
  if (fixtureMode()) return fx.remove(id);
  try {
    const res = await fetch(`${routerUrl()}/attachments/${id}`, { method: "DELETE", headers: auth(), cache: "no-store" });
    const j = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, body: res.ok ? j : { error: detailOf(j, "Couldn't remove the file.") } };
  } catch {
    return { status: 503, body: { error: "The router is not reachable." } };
  }
}

export async function estimate(body: unknown): Promise<Out> {
  if (fixtureMode()) return fx.estimate(body);
  try {
    const res = await fetch(`${routerUrl()}/chat/estimate`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, body: res.ok ? (j as AttachmentEstimate) : { error: detailOf(j, "No estimate.") } };
  } catch {
    return { status: 503, body: { error: "The router is not reachable." } };
  }
}

/**
 * A file or its thumbnail. Whatever the router says, only a raster image type is served inline (with a
 * CSP that allows nothing and a sandbox); everything else is an opaque download. `nosniff` always.
 */
export async function file(id: string, thumb: boolean): Promise<Response> {
  let res: Response;
  if (fixtureMode()) {
    res = fx.file(id, thumb);
  } else {
    try {
      res = await fetch(`${routerUrl()}/attachments/${id}${thumb ? "/thumb" : ""}`, {
        headers: auth(),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return new Response("router unreachable", { status: 503 });
    }
  }
  if (!res.ok) return new Response(null, { status: res.status === 404 ? 404 : 502 });
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const name = res.headers.get("content-disposition")?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "file";
  const inline = IMAGE_TYPES.has(type);
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": inline ? INLINE_IMAGE_CSP : "default-src 'none'; sandbox",
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
  };
  return new Response(res.body, { status: 200, headers });
}
