"use client";

import * as React from "react";

/**
 * A `next/dynamic` loading slot that shows a stand-in chosen by the caller (the loading option
 * gets no props). Wrap the dynamic component in <LazyFallback value={…}> and pass
 * `loading: FallbackSlot`: the stand-in renders on the server and until the chunk arrives, so a
 * lazy popover or Markdown renderer never flickers or shifts the layout.
 */
const Ctx = React.createContext<React.ReactNode>(null);

export function LazyFallback({ value, children }: { value: React.ReactNode; children: React.ReactNode }) {
  return <Ctx value={value}>{children}</Ctx>;
}

export function FallbackSlot() {
  return <>{React.useContext(Ctx)}</>;
}
