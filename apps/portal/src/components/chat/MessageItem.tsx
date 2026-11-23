"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Brain, ChevronDown, Cpu, Pencil, RefreshCw, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { CopyButton } from "@/components/kit/CopyButton";
import { Button } from "@/components/ui/button";
import { ms, usd } from "@/lib/chat-format";
import type { AttachmentInfo, ChatMessage, RouteInfo } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";
import { tChat } from "@/i18n/chat";
import { Markdown } from "./Markdown";
import { WhyThis } from "./WhyThis";
import { MessageAttachments } from "./MessageAttachments";

// Rare reply states (Studio notice, budget block, job hint) and their icons load on demand.
const JobHint = dynamic(() => import("./MessageExtras").then((m) => m.JobHint), { ssr: false });
const Notice = dynamic(() => import("./MessageExtras").then((m) => m.Notice), { ssr: false });
const Blocked = dynamic(() => import("./MessageExtras").then((m) => m.Blocked), { ssr: false });
const ReplyError = dynamic(() => import("./MessageExtras").then((m) => m.ReplyError), { ssr: false });
// M3a notes (auto-private, masked secret) are rare too: their own chunk, strings included.
const SensitiveNote = dynamic(() => import("./PrivacyNotes").then((m) => m.SensitiveNote), { ssr: false });
const SecretNote = dynamic(() => import("./PrivacyNotes").then((m) => m.SecretNote), { ssr: false });

/** Client-only streaming state; never persisted (thinking text especially). */
export interface Live {
  thinking: string;
  thinkStart: number | null;
  thinkEnd: number | null;
  label: string | null;
  note: { label: string; reason: string; next: string | null } | null;
}

export type UiMessage = ChatMessage & { live?: Live };

function Thinking({ live, savedMs, streaming }: { live?: Live; savedMs: number | null; streaming: boolean }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const text = live?.thinking ?? "";
  const active = streaming && !!live?.thinkStart && !live.thinkEnd;
  const took = live?.thinkStart && live.thinkEnd ? live.thinkEnd - live.thinkStart : savedMs;
  if (!active && !text && !took) return null;
  const label = active ? tChat("chat.thinking") : tChat("chat.thoughtFor", { time: ms(took ?? 0) });
  if (!text) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Brain aria-hidden className="size-3.5" /> {label}
      </p>
    );
  }
  return (
    <div className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-chip px-1 py-0.5 font-semibold text-ink-muted hover:text-ink"
      >
        <Brain aria-hidden className={cn("size-3.5", active && "motion-safe:animate-pulse")} />
        {label}
        <span className="sr-only">{open ? tChat("chat.hideThinking") : tChat("chat.showThinking")}</span>
        <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div id={id} className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-control border border-hairline p-2 text-ink-muted">
          {text}
          <p className="mt-1 italic">{tChat("chat.thinkingNote")}</p>
        </div>
      )}
    </div>
  );
}

/** Which model answered, at the top of each reply: a monogram (or a chip icon for local models). */
function Via({ r }: { r: RouteInfo }) {
  const name = r.provider_name ?? r.label;
  if (!name) return null;
  const local = r.provider === "ollama";
  return (
    <p className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[0.625rem] font-bold text-accent-strong uppercase"
      >
        {local ? <Cpu className="size-3" strokeWidth={2.5} /> : name.trim().charAt(0)}
      </span>
      <span className="truncate" data-tip-truncated>
        <span className="font-semibold text-ink">{name}</span>
        {r.model && <span className="font-mono"> · {r.model}</span>}
      </span>
    </p>
  );
}

export interface MessageActions {
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
  onFeedback?: (id: number, value: "up" | "down" | null) => void;
  /** "Not sensitive — use cloud" on the last reply that auto-detection kept local (M3a). */
  onCloudOverride?: () => void;
}

export function MessageItem({
  m,
  last,
  busy,
  actions,
  prompt,
  promptFiles,
}: {
  m: UiMessage;
  last: boolean;
  busy: boolean;
  actions: MessageActions;
  /** The user message this reply answers ("Run as job" starts from it). */
  prompt?: string;
  /** M2.5: that message's files (Run as job takes them along). */
  promptFiles?: AttachmentInfo[];
}) {
  if (m.role === "user") return <UserMessage m={m} editable={last && !busy} onEdit={actions.onEdit} />;
  const r = m.route;
  const streaming = m.status === "streaming";
  const live = m.live;
  return (
    <article aria-label={tChat("chat.assistant")} data-reply className="reply surface-strong grid grid-cols-[minmax(0,1fr)] gap-2 rounded-panel p-4" aria-busy={streaming || undefined}>
      {r?.target && !streaming && <Via r={r} />}
      <Thinking live={live} savedMs={r?.thinking_ms ?? null} streaming={streaming} />
      {streaming && !m.content && (
        <p role="status" className="text-sm text-ink-muted">
          {live?.note
            ? live.note.next
              ? tChat("chat.fallingBack", { label: live.note.label, reason: live.note.reason, next: live.note.next })
              : tChat("chat.fallingBackNone", { label: live.note.label, reason: live.note.reason })
            : live?.label
              ? tChat("chat.answering", { label: live.label })
              : tChat("chat.routing")}
        </p>
      )}
      {m.content && (
        <div className="text-[0.9375rem] leading-relaxed">
          <Markdown text={m.content} />
        </div>
      )}
      {!streaming && r?.sensitive && !r.sensitive.already_private && (
        <SensitiveNote s={r.sensitive} onOverride={last && !busy ? actions.onCloudOverride : undefined} />
      )}
      {m.status === "notice" && r?.notice && <Notice kind={r.notice} />}
      {m.status === "blocked" && r?.blocked && <Blocked b={r.blocked} />}
      {m.status === "error" && <ReplyError code={r?.error_code} detail={r?.error} />}
      {m.status === "stopped" && (
        <p className="flex items-center gap-1.5 text-sm text-ink-muted">
          <Square aria-hidden className="size-3.5" /> {tChat("chat.stopped")}
        </p>
      )}
      {r?.job_suggested && m.status !== "streaming" && <JobHint id={m.id} requestId={r.request_id} prompt={prompt ?? ""} files={promptFiles} isPrivate={r.private} />}
      {!streaming && r && <Footer m={m} last={last} busy={busy} actions={actions} />}
    </article>
  );
}

function Footer({ m, last, busy, actions }: { m: UiMessage; last: boolean; busy: boolean; actions: MessageActions }) {
  const r = m.route!;
  const answered = !!r.target;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {answered && <WhyThis route={r} />}
      {answered && r.cost_usd != null && (
        <span className="hidden text-[0.8125rem] font-semibold tabular-nums text-ink-muted sm:inline">
          {r.cost_usd === 0 ? t("cost.free") : usd(r.cost_usd)}
        </span>
      )}
      <span className={cn("msg-actions ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5", last && "is-last")}>
        {m.content && <CopyButton text={m.content} label={tChat("chat.copy")} />}
        {last && !busy && actions.onRegenerate && m.status !== "notice" && (
          <Button type="button" size="sm" variant="glass" onClick={actions.onRegenerate}>
            <RefreshCw aria-hidden className="size-4" /> {tChat("chat.regenerate")}
          </Button>
        )}
        {answered && m.status === "done" && actions.onFeedback && (
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={tChat("chat.good")}
              data-tip={tChat("chat.good")}
              aria-pressed={m.feedback === "up"}
              onClick={() => actions.onFeedback!(m.id, m.feedback === "up" ? null : "up")}
              className={cn("size-9 min-h-9", m.feedback === "up" && "bg-accent-soft text-accent-strong")}
            >
              <ThumbsUp aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={tChat("chat.bad")}
              data-tip={tChat("chat.bad")}
              aria-pressed={m.feedback === "down"}
              onClick={() => actions.onFeedback!(m.id, m.feedback === "down" ? null : "down")}
              className={cn("size-9 min-h-9", m.feedback === "down" && "bg-accent-soft text-accent-strong")}
            >
              <ThumbsDown aria-hidden className="size-4" />
            </Button>
          </>
        )}
      </span>
    </div>
  );
}




function UserMessage({ m, editable, onEdit }: { m: UiMessage; editable: boolean; onEdit?: (text: string) => void }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(m.content);
  const id = React.useId();
  if (editing) {
    return (
      <form
        className="ml-auto grid w-full max-w-[85%] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            setEditing(false);
            onEdit?.(draft.trim());
          }
        }}
      >
        <label htmlFor={id} className="label">
          {tChat("chat.editLabel")}
        </label>
        <textarea id={id} value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="surface-strong w-full rounded-panel p-3" />
        <span className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {tChat("chat.cancel")}
          </Button>
          <Button type="submit" size="sm">
            {tChat("chat.editSend")}
          </Button>
        </span>
      </form>
    );
  }
  return (
    <div className="group ml-auto grid max-w-[85%] justify-items-end gap-1">
      {m.attachments && m.attachments.length > 0 && <MessageAttachments files={m.attachments} />}
      {(m.content || !m.attachments?.length) && (
        <p className="rounded-panel bg-accent-soft px-4 py-2.5 whitespace-pre-wrap text-ink">
          <span className="sr-only">{tChat("chat.you")}: </span>
          {m.content}
        </p>
      )}
      {m.secret && m.secret.kinds.length > 0 && <SecretNote kinds={m.secret.kinds} />}
      {editable && onEdit && (
        <Button type="button" size="sm" variant="ghost" onClick={() => (setDraft(m.content), setEditing(true))}>
          <Pencil aria-hidden className="size-3.5" /> {tChat("chat.edit")}
        </Button>
      )}
    </div>
  );
}
