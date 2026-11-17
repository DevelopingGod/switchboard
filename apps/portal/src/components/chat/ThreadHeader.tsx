"use client";

import dynamic from "next/dynamic";
import { Lock } from "lucide-react";
import type { ChatThread } from "@/lib/router-types";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";
import { tChat } from "@/i18n/chat";

/** Title + private badge. Server-rendered; the rename/delete controls load after hydration. */
export function StaticHeader({ title, privateThread, children }: { title: string; privateThread: boolean; children?: React.ReactNode }) {
  return (
    <header className="flex min-h-10 flex-wrap items-center gap-3">
      <h1 id="chat-title" className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight">
        {title}
      </h1>
      {privateThread && (
        <span className="inline-flex items-center gap-1.5 rounded-chip border border-hairline bg-glass-strong px-2.5 py-1 text-[0.8125rem] font-semibold">
          <Lock aria-hidden className="size-3.5 text-accent-strong" /> {tChat("chat.privateThread")}
        </span>
      )}
      {children}
    </header>
  );
}

const Impl = dynamic(() => import("./ThreadHeaderImpl"), { ssr: false, loading: FallbackSlot });

export function ThreadHeader(props: { thread: ChatThread | null; fallback: React.ReactNode; onRenamed: (t: ChatThread) => void }) {
  if (!props.thread) return props.fallback;
  return (
    <LazyFallback value={props.fallback}>
      <Impl thread={props.thread} onRenamed={props.onRenamed} />
    </LazyFallback>
  );
}
