"use client";

import * as React from "react";
import { Paperclip, X } from "lucide-react";
import type { AttachmentInfo } from "@/lib/router-types";
import { ACCEPT, type Attachments } from "@/lib/attachments";
import { Button } from "@/components/ui/button";
import { ComposerAttachments } from "@/components/chat/ComposerAttachments";
import { FileIcon, fileMeta } from "@/components/chat/MessageAttachments";
import { tChat } from "@/i18n/chat";
import { tJobs } from "@/i18n/jobs";

/** M2.5: the files a job gets (the chat's, plus any added here). They are copied into the job's worktree under a
 * git-ignored `.switchboard/attachments/` folder and never committed. */
export function JobFiles({ carried, onUncarry, att }: { carried: AttachmentInfo[]; onUncarry: (id: string) => void; att: Attachments }) {
  const picker = React.useRef<HTMLInputElement>(null);
  const id = React.useId();
  return (
    <div className="grid gap-1.5">
      <span id={id} className="text-sm font-semibold">
        {tJobs("run.files")}
      </span>
      <p className="text-xs text-ink-muted">{tJobs("run.filesHint")}</p>
      {carried.length > 0 && (
        <ul aria-labelledby={id} className="flex flex-wrap gap-2">
          {carried.map((f) => (
            <li key={f.id} className="flex max-w-64 items-center gap-2 rounded-chip border border-hairline bg-glass-strong py-1 pr-1 pl-2 text-sm">
              <FileIcon kind={f.kind} code={f.code} />
              <span className="grid min-w-0 leading-tight">
                <span className="truncate font-semibold">{f.name}</span>
                <span className="truncate text-xs text-ink-muted">{fileMeta(f)}</span>
              </span>
              <button
                type="button"
                onClick={() => onUncarry(f.id)}
                aria-label={tChat("chat.attach.remove", { name: f.name })}
                className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-pill-active"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ComposerAttachments att={att} />
      <div>
        <Button type="button" size="sm" variant="glass" onClick={() => picker.current?.click()}>
          <Paperclip aria-hidden className="size-4" /> {tJobs("run.addFiles")}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            if (e.target.files?.length) att.add(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
