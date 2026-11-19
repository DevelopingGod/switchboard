"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { RouteChip } from "@/components/kit/RouteChip";
import { chipTarget } from "@/lib/chat-format";
import { usePrefs } from "@/lib/prefs";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";
import type { RouteInfo } from "@/lib/router-types";

// Radix Popover (~23 KB gzip) is a lazy chunk; the static chip holds the layout until it arrives.
const Impl = dynamic(() => import("./WhyPopoverImpl"), { ssr: false, loading: FallbackSlot });

export function WhyThis({ route }: { route: RouteInfo }) {
  // A click on the stand-in (before the chunk arrives, e.g. on a busy machine) is not lost: the
  // popover opens as soon as it has loaded.
  const [pending, setPending] = React.useState(false);
  const pro = usePrefs().mode === "pro";
  return (
    <LazyFallback
      value={
        <RouteChip
          target={chipTarget(route)}
          rule={pro ? route.rule : undefined}
          aria-busy={pending || undefined}
          onClick={() => {
            setPending(true);
            void import("./WhyPopoverImpl");
          }}
        />
      }
    >
      <Impl route={route} openOnMount={pending} />
    </LazyFallback>
  );
}
