"use client";

import { FileCode2, FileText, Image as ImageIcon } from "lucide-react";
import type { AttachmentInfo } from "@/lib/router-types";
import { formatBytes } from "@/lib/attachments-format";
import { tChat } from "@/i18n/chat";

/**
 * M2.5: the files on a sent message: image thumbnails in a box sized from the image's own ratio (so nothing
 * shifts as they load; click opens the full image) and documents as download chips. Only raster images are
 * ever shown inline; everything else is a download.
 */

export function FileIcon({ kind, code }: { kind?: AttachmentInfo["kind"]; code?: boolean }) {
  const C = kind === "image" ? ImageIcon : code ? FileCode2 : FileText;
  return <C aria-hidden className="size-4 shrink-0 text-accent-strong" />;
}

export function fileMeta(a: AttachmentInfo): string {
  const parts = [formatBytes(a.bytes)];
  if (a.pages) parts.push(tChat("chat.attach.pages", { n: a.pages }));
  return parts.join(" · ");
}

/** Files on a sent message. Images: a 4:3 box capped at 240 px wide; click opens the full image. */
export function MessageAttachments({ files }: { files: AttachmentInfo[] }) {
  if (!files.length) return null;
  const images = files.filter((a) => a.kind === "image");
  const docs = files.filter((a) => a.kind !== "image");
  return (
    <div className="grid justify-items-end gap-2" data-message-attachments>
      {images.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2">
          {images.map((a) => {
            const w = 240;
            const h = a.width && a.height ? Math.max(60, Math.min(240, Math.round((w * a.height) / a.width))) : 180;
            return (
              <li key={a.id}>
                <a
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={tChat("chat.attach.open", { name: a.name })}
                  className="block overflow-hidden rounded-panel border border-hairline bg-glass-strong focus-visible:outline-2"
                  style={{ width: w, height: h }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- our own thumbnail route (strict CSP, nosniff) */}
                  <img
                    src={`/api/attachments/${a.id}/thumb`}
                    alt={tChat("chat.attach.imageAlt", { name: a.name })}
                    width={w}
                    height={h}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                  />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {docs.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-2">
          {docs.map((a) => (
            <li key={a.id}>
              <a
                href={`/api/attachments/${a.id}`}
                download={a.name}
                aria-label={tChat("chat.attach.download", { name: a.name })}
                className="flex max-w-64 items-center gap-2 rounded-chip border border-hairline bg-glass-strong px-2.5 py-1.5 text-sm hover:bg-pill-active"
              >
                <FileIcon kind={a.kind} code={a.code} />
                <span className="grid min-w-0 leading-tight">
                  <span className="truncate font-semibold" data-tip-truncated>
                    {a.name}
                  </span>
                  <span className="truncate text-xs text-ink-muted">{fileMeta(a)}</span>
                </span>
              </a>
              {a.note && <p className="mt-1 max-w-64 text-right text-xs text-ink-muted">{a.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
