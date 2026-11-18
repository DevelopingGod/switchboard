"use client";

import * as React from "react";
import { ChevronDown, KeyRound, ListCollapse, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { SensitiveInfo, ThreadSummary } from "@/lib/router-types";
import { type PrivacyKey, tPriv } from "@/i18n/privacy";

/**
 * M3a chat notes, in one lazy chunk (rare states, like MessageExtras):
 * - SensitiveNote on a reply that auto-detection kept local, with the one-click override;
 * - SecretNote on a user message whose pasted secret was masked (no override);
 * - SummaryNote where a long thread's running summary takes over from the full messages.
 */
export function SensitiveNote({ s, onOverride }: { s: SensitiveInfo; onOverride?: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const category = tPriv(`sensitive.category.${s.category}` as PrivacyKey);
  return (
    <div data-note="sensitive" className="flex flex-wrap items-center gap-2 rounded-control border border-hairline p-2 text-sm">
      <ShieldCheck aria-hidden className="size-4 shrink-0 text-ok" />
      <span className="min-w-0 flex-1">
        {s.source === "secret" ? (
          <span className="font-semibold">{tPriv("sensitive.secretKept")}</span>
        ) : (
          <>
            <span className="font-semibold">{tPriv("sensitive.kept", { category })}</span>{" "}
            <span className="text-ink-muted">{tPriv("sensitive.why")}</span>
          </>
        )}
      </span>
      {s.overridable && onOverride && (
        <Button
          type="button"
          size="sm"
          variant="glass"
          loading={busy}
          onClick={() => {
            setBusy(true);
            onOverride();
          }}
        >
          {busy ? tPriv("sensitive.overriding") : tPriv("sensitive.override")}
        </Button>
      )}
    </div>
  );
}

export function SecretNote({ kinds }: { kinds: string[] }) {
  const names = kinds.map((k) => tPriv(`secret.kind.${k}` as PrivacyKey)).join(", ");
  return (
    <p data-note="secret" role="note" className="flex max-w-full items-start gap-1.5 text-xs text-ink-muted">
      <KeyRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span>
        <span className="font-semibold text-ink">{tPriv("secret.note")}</span> {tPriv("secret.kinds", { kinds: names })}
      </span>
    </p>
  );
}

export function SummaryNote({ s }: { s: ThreadSummary }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div data-note="summary" className="rounded-control border border-dashed border-hairline p-2 text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-chip px-1 py-0.5 text-left font-semibold text-ink-muted hover:text-ink"
      >
        <ListCollapse aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">{tPriv("summary.title")}</span>
        <ChevronDown aria-hidden className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div id={id} className="mt-1 grid gap-1 px-1">
          <p className="text-xs text-ink-muted">{tPriv("summary.covers", { count: s.covers })}</p>
          <p className="whitespace-pre-wrap">{s.text}</p>
          {s.model && <p className="text-xs text-ink-muted">{tPriv("summary.by", { model: s.model })}</p>}
        </div>
      )}
    </div>
  );
}
