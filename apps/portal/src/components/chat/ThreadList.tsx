"use client";

import Link from "next/link";
import { Lock, Plus } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import type { ChatThread } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tChat } from "@/i18n/chat";

export function ThreadList({ threads, current, onNew }: { threads: ChatThread[]; current: string | null; onNew: () => void }) {
  return (
    <GlassPanel as="nav" tone="strong" aria-label={tChat("chat.threads")} className="grid content-start gap-3 self-start lg:sticky lg:top-24">
      <div className="flex items-center justify-between gap-2">
        <h2 className="label">{tChat("chat.threads")}</h2>
        <Link
          href="/chat"
          onClick={onNew}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-chip bg-accent px-3 text-[0.8125rem] font-semibold text-on-accent"
        >
          <Plus aria-hidden className="size-3.5" /> {tChat("chat.newChat")}
        </Link>
      </div>
      {threads.length === 0 ? (
        <p className="text-sm text-ink-muted">{tChat("chat.noThreads")}</p>
      ) : (
        <ul className="grid max-h-[60vh] gap-0.5 overflow-y-auto">
          {threads.map((th) => (
            <li key={th.id}>
              <Link
                href={`/chat?t=${th.id}`}
                aria-current={th.id === current ? "page" : undefined}
                className={cn(
                  "flex min-h-9 items-center gap-2 rounded-control px-2.5 py-1.5 text-sm",
                  th.id === current ? "bg-pill-active font-semibold" : "hover:bg-pill-active",
                )}
              >
                {th.private && (
                  <>
                    <Lock aria-hidden className="size-3.5 shrink-0 text-accent-strong" />
                    <span className="sr-only">{tChat("chat.privateBadge")}: </span>
                  </>
                )}
                <span className="truncate">{th.title || tChat("chat.untitled")}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </GlassPanel>
  );
}
