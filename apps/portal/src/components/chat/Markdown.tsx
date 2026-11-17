"use client";

import dynamic from "next/dynamic";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";

const Impl = dynamic(() => import("./MarkdownImpl"), { ssr: false, loading: FallbackSlot });

/**
 * Reply text: plain text first (server render, and until the chunk arrives), then Markdown.
 * react-markdown + remark-gfm stay out of the route's first-load JS.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <LazyFallback value={<div className="whitespace-pre-wrap">{text}</div>}>
      <Impl text={text} />
    </LazyFallback>
  );
}
