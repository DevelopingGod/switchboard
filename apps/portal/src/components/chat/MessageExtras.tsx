"use client";

import Link from "next/link";
import { Briefcase, Clapperboard, ImagePlus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/chat-format";
import type { BlockedInfo } from "@/lib/router-types";
import { type ChatKey, tChat } from "@/i18n/chat";
import { ErrorNote } from "@/components/kit/ErrorNote";

/** A failed reply: one plain sentence; the raw reason only in Pro mode (Regenerate is in the footer). */
export function ReplyError({ code, detail }: { code?: string | null; detail?: string | null }) {
  return <ErrorNote live code={code ?? (detail ? "error" : "unknown")} detail={detail} />;
}

/** Rare reply states, in their own chunk (see MessageItem). */
export function JobHint({ id }: { id: number }) {
  const hint = `job-hint-${id}`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control border border-hairline p-2 text-sm">
      <Briefcase aria-hidden className="size-4 text-accent-strong" />
      <span id={hint} className="min-w-0 flex-1 text-ink-muted">
        {tChat("chat.jobHint")}
      </span>
      <Button type="button" size="sm" variant="glass" disabled aria-describedby={hint}>
        {tChat("chat.runAsJob")}
      </Button>
    </div>
  );
}

export function Notice({ kind }: { kind: "image" | "video" | "audio" }) {
  const Icon = kind === "video" ? Clapperboard : ImagePlus;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Icon aria-hidden className="size-4 text-accent-strong" />
      <span className="min-w-0 flex-1">{tChat(`chat.notice.${kind}` as ChatKey)}</span>
      <Link href="/studio" className="font-semibold text-accent-strong underline underline-offset-4">
        {tChat("chat.notice.open")}
      </Link>
    </div>
  );
}

export function Blocked({ b }: { b: BlockedInfo }) {
  return (
    <div role="alert" className="grid gap-1 rounded-control border border-warn p-3 text-sm">
      <p className="flex items-center gap-1.5 font-semibold">
        <ShieldAlert aria-hidden className="size-4 text-warn" /> {tChat("chat.blocked.title")}
      </p>
      <p>
        {b.code === "budget_daily"
          ? tChat("chat.blocked.daily", { cap: usd(b.daily_cap_usd), spent: usd(b.spent_today) })
          : tChat("chat.blocked.request", { cap: usd(b.max_cost_usd) })}
      </p>
      <p className="text-ink-muted">{tChat("chat.blocked.hint")}</p>
    </div>
  );
}
