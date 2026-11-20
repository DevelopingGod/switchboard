"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";
import { whenIdle } from "@/lib/idle-queue";

const Impl = dynamic(() => import("./MarkdownImpl"), { ssr: false, loading: FallbackSlot });

/**
 * Reply text: plain text first (server render, and until it is upgraded), then Markdown.
 * react-markdown + remark-gfm stay out of the route's first-load JS, and each reply is upgraded on its own,
 * in an idle slice, once it is near the screen (M4b): a long thread no longer turns into one long task after
 * load. Replies far above stay plain text until you scroll toward them (Chrome's scroll anchoring keeps
 * what you are reading still when they grow).
 */
export function Markdown({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [rich, setRich] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || rich) return;
    let cancel: (() => void) | undefined;
    const upgrade = () => {
      cancel = whenIdle(() => React.startTransition(() => setRich(true)));
    };
    if (typeof IntersectionObserver === "undefined") {
      upgrade();
      return () => cancel?.();
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          upgrade();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancel?.();
    };
  }, [rich]);
  const plain = <div className="whitespace-pre-wrap">{text}</div>;
  return (
    <div ref={ref}>
      {rich ? (
        <LazyFallback value={plain}>
          <Impl text={text} />
        </LazyFallback>
      ) : (
        plain
      )}
    </div>
  );
}
