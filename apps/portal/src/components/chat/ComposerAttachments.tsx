"use client";

import * as React from "react";
import { AlertTriangle, Loader2, ShieldCheck, X } from "lucide-react";
import { estimateText, type Attachments, type PendingFile } from "@/lib/attachments";
import { FileIcon, fileMeta } from "./MessageAttachments";
import { tChat } from "@/i18n/chat";
import { cn } from "@/lib/cn";

/** M2.5: the chips in the composer (progress, remove, the token estimate). Loaded only once a file is added. */

export function ComposerAttachments({ att }: { att: Attachments }) {
  const { files, notice, estimate } = att;
  if (!files.length && !notice) return null;
  return (
    <div className="grid gap-2" data-attachments>
      {files.length > 0 && (
        <ul aria-label={tChat("chat.attach.label")} className="flex flex-wrap gap-2">
          {files.map((f) => (
            <Chip key={f.key} f={f} onRemove={() => att.remove(f.key)} />
          ))}
        </ul>
      )}
      {notice && (
        <p role="status" className="flex items-center gap-1.5 text-sm text-ink">
          <AlertTriangle aria-hidden className="size-4 text-warn" /> {notice}
        </p>
      )}
      {estimate && (
        <p
          data-estimate
          className={cn("text-sm", estimate.blocked ? "flex items-start gap-1.5 text-ink" : "text-ink-muted")}
          role={estimate.blocked ? "status" : undefined}
        >
          {estimate.blocked && <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />}
          {estimateText(estimate)}
        </p>
      )}
    </div>
  );
}

function Chip({ f, onRemove }: { f: PendingFile; onRemove: () => void }) {
  const err = f.status === "error";
  return (
    <li
      className={cn(
        "relative flex max-w-64 items-center gap-2 overflow-hidden rounded-chip border bg-glass-strong py-1 pr-1 pl-1.5 text-sm",
        err ? "border-err" : "border-hairline",
      )}
    >
      {f.preview || (f.info?.kind === "image" && f.info) ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL or our own thumbnail route
        <img src={f.preview ?? `/api/attachments/${f.info!.id}/thumb`} alt="" width={28} height={28} className="size-7 shrink-0 rounded-[6px] object-cover" />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center">
          <FileIcon kind={f.info?.kind} code={f.info?.code} />
        </span>
      )}
      <span className="grid min-w-0 leading-tight">
        <span className="truncate font-semibold" data-tip-truncated>
          {f.name}
        </span>
        <span className={cn("truncate text-xs", err ? "text-err" : "text-ink-muted")}>
          {f.status === "uploading" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              {tChat("chat.attach.uploading")} {Math.round(f.progress * 100)}%
            </span>
          ) : err ? (
            f.error
          ) : f.info ? (
            fileMeta(f.info)
          ) : null}
        </span>
        {f.info?.secret && (
          <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
            <ShieldCheck aria-hidden className="size-3" /> {tChat("chat.attach.secret", { name: f.name })}
          </span>
        )}
        {f.info?.note && <span className="text-xs text-ink-muted">{f.info.note}</span>}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={tChat("chat.attach.remove", { name: f.name })}
        data-tip={tChat("chat.attach.remove", { name: f.name })}
        className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-pill-active focus-visible:bg-pill-active"
      >
        <X aria-hidden className="size-3.5" />
      </button>
      {f.status === "uploading" && (
        <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-accent transition-[width] duration-200" style={{ width: `${Math.round(f.progress * 100)}%` }} />
      )}
    </li>
  );
}

