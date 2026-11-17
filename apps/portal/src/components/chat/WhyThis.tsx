"use client";

import dynamic from "next/dynamic";
import { RouteChip } from "@/components/kit/RouteChip";
import { chipTarget } from "@/lib/chat-format";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";
import type { RouteInfo } from "@/lib/router-types";

// Radix Popover (~23 KB gzip) is a lazy chunk; the static chip holds the layout until it arrives.
const Impl = dynamic(() => import("./WhyPopoverImpl"), { ssr: false, loading: FallbackSlot });

export function WhyThis({ route }: { route: RouteInfo }) {
  return (
    <LazyFallback value={<RouteChip target={chipTarget(route)} rule={route.rule} />}>
      <Impl route={route} />
    </LazyFallback>
  );
}
