import "server-only";
import type { AttachmentEstimate, AttachmentInfo } from "@/lib/router-types";

/**
 * In-memory attachments for PORTAL_DATA=fixture (tests and screenshots). Types are decided from the bytes,
 * like the router does, so the security tests exercise the portal's own handling too.
 */
const store = new Map<string, { info: AttachmentInfo; bytes: Uint8Array }>();

// A 4x3 periwinkle PNG, for the seeded fixture thread.
const SAMPLE_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFUlEQVR4nGPo6Oj4jwMwIEswMPj/BwCKNA5gFcwZ6AAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export const SEEDED: AttachmentInfo[] = [
  info("6a1b2c3d-0000-4000-8000-000000000001", "chart.png", "image", "image/png", SAMPLE_PNG.length, { width: 1200, height: 900, tokens: 1032 }),
  info("6a1b2c3d-0000-4000-8000-000000000002", "q3-report.pdf", "pdf", "application/pdf", 182_311, { pages: 12, text_chars: 21_400, tokens: 5350 }),
];
store.set(SEEDED[0].id, { info: SEEDED[0], bytes: SAMPLE_PNG });
store.set(SEEDED[1].id, { info: SEEDED[1], bytes: new TextEncoder().encode("%PDF-1.4\n% fixture\n") });

function info(
  id: string,
  name: string,
  kind: AttachmentInfo["kind"],
  mime: string,
  bytes: number,
  extra: Partial<AttachmentInfo> = {},
): AttachmentInfo {
  return {
    id,
    name,
    kind,
    mime,
    bytes,
    code: false,
    pages: null,
    pages_read: null,
    width: null,
    height: null,
    text_chars: 0,
    tokens: 0,
    truncated: false,
    secret: null,
    note: null,
    status: "bound",
    ...extra,
  };
}

const CODE = /\.(py|js|ts|tsx|go|rs|java|c|cpp|sh|sql|rb)$/i;
const TEXT = /\.(txt|md|csv|json|yaml|yml|log|toml|xml)$/i;

function sniff(b: Uint8Array, name: string): { kind: AttachmentInfo["kind"]; mime: string; code?: boolean } | string {
  const head = (n: number) => Array.from(b.slice(0, n));
  const starts = (sig: number[]) => sig.every((x, i) => b[i] === x);
  if (b.length === 0) return "The file is empty.";
  if (starts([0x4d, 0x5a]) || starts([0x7f, 0x45, 0x4c, 0x46])) return "This looks like a program. Attach images, PDFs or text files only.";
  if (starts([0x50, 0x4b, 0x03, 0x04])) return "This looks like an archive (zip, docx, xlsx, jar…). Attach images, PDFs or text files only.";
  if (starts([0x89, 0x50, 0x4e, 0x47])) return /\.png$/i.test(name) ? { kind: "image", mime: "image/png" } : "The file name doesn't match its content (it is an image). Rename it and try again.";
  if (starts([0xff, 0xd8, 0xff])) return /\.jpe?g$/i.test(name) ? { kind: "image", mime: "image/jpeg" } : "The file name doesn't match its content (it is an image). Rename it and try again.";
  if (starts([0x25, 0x50, 0x44, 0x46])) return /\.pdf$/i.test(name) ? { kind: "pdf", mime: "application/pdf" } : "The file name doesn't match its content (it is a PDF). Rename it and try again.";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(b.slice(0, 2048));
  if (/^\s*(<\?xml|<!doctype html|<html|<svg|<script)/i.test(text) || /\.(html?|svg)$/i.test(name)) return "HTML and SVG files aren't accepted (they can run code). Paste the text instead.";
  if (head(2048).includes(0)) return "This file type isn't supported. Attach images (PNG, JPEG, WebP, GIF), PDFs or text.";
  if (CODE.test(name)) return { kind: "text", mime: "text/plain", code: true };
  if (TEXT.test(name)) return { kind: "text", mime: "text/plain" };
  return "This file type isn't on the list of accepted text files.";
}

export async function upload(body: ReadableStream<Uint8Array> | null, name: string): Promise<{ status: number; body: unknown }> {
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) return { status: 413, body: { error: "This file is over the 10 MB limit." } };
  const s = sniff(bytes, name);
  if (typeof s === "string") return { status: 415, body: { error: s } };
  const id = crypto.randomUUID();
  const text = s.kind === "text" ? new TextDecoder().decode(bytes) : "";
  const isPdf = s.kind === "pdf";
  const a = info(id, name.replace(/[^\w.\- ()]+/g, "_").slice(0, 120), s.kind, s.mime, bytes.length, {
    code: !!s.code,
    status: "staged",
    // A PNG's real size from its header (like the router reports); other images a 4:3 stand-in.
    width: s.kind === "image" ? (s.mime === "image/png" && bytes.length > 24 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) : 1024) : null,
    height: s.kind === "image" ? (s.mime === "image/png" && bytes.length > 24 ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(20) : 768) : null,
    pages: isPdf ? 1 : null,
    text_chars: s.kind === "text" ? text.length : isPdf ? 900 : 0,
    tokens: s.kind === "image" ? 1032 : Math.max(1, Math.floor((s.kind === "text" ? text.length : 900) / 4)),
    secret: /sk-[A-Za-z0-9]{20,}/.test(text) ? ["api_key"] : null,
    note: isPdf && name.includes("scan") ? "No text found: this looks like a scanned PDF. Text recognition (OCR) comes later." : null,
  });
  store.set(id, { info: a, bytes });
  return { status: 200, body: a };
}

export function remove(id: string): { status: number; body: unknown } {
  store.delete(id);
  return { status: 200, body: { deleted: id } };
}

export function bind(ids: string[]): AttachmentInfo[] {
  return ids.flatMap((id) => {
    const a = store.get(id);
    if (!a) return [];
    a.info = { ...a.info, status: "bound" };
    return [a.info];
  });
}

export function get(id: string): AttachmentInfo | null {
  return store.get(id)?.info ?? null;
}

export function estimate(body: unknown): { status: number; body: AttachmentEstimate } {
  const b = (body ?? {}) as { attachment_ids?: string[]; text?: string; private?: boolean };
  const atts = (b.attachment_ids ?? []).map((id) => store.get(id)?.info).filter((a): a is AttachmentInfo => !!a);
  const vision = atts.some((a) => a.kind === "image");
  const n = atts.reduce((s, a) => s + a.tokens, 0);
  const priv = !!b.private || atts.some((a) => a.secret);
  const blocked = priv && vision ? "no_local_vision" : null;
  return {
    status: 200,
    body: {
      tokens: n + Math.floor((b.text ?? "").length / 4),
      attachment_tokens: n,
      documented: vision && !priv && atts.every((a) => a.kind === "image"),
      model: blocked ? null : priv ? "Ollama · qwen3:4b" : vision ? "Google AI Studio · gemini-3.1-flash-lite" : "Groq · gpt-oss-120b",
      provider: blocked ? null : priv ? "ollama" : vision ? "gemini" : "groq",
      local: blocked ? null : priv,
      private: priv,
      needs_vision: vision,
      long_document: n > 12_000 && !vision,
      blocked,
    },
  };
}

export function file(id: string, thumb: boolean): Response {
  const a = store.get(id);
  if (!a || (thumb && a.info.kind !== "image")) return new Response(null, { status: 404 });
  return new Response(new Blob([a.bytes as BlobPart]), {
    headers: {
      "Content-Type": a.info.kind === "image" ? a.info.mime : "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.info.name)}`,
    },
  });
}
