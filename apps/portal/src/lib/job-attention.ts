"use client";

import { useSyncExternalStore } from "react";

/**
 * How many jobs wait for you (M4b), shared by the sidebar badge and the job watcher. Tiny on purpose: it
 * ships with the sidebar; the watcher that polls and raises toasts is a lazy chunk.
 */
let needsYou: number | null = null; // null until the first check answers (or fails)
const listeners = new Set<() => void>();

export function setNeedsYou(n: number) {
  if (n === needsYou) return;
  needsYou = n;
  for (const l of listeners) l();
}

/** null = not checked yet (the sidebar marks itself `data-jobs-checked` once it is, for tests and captures). */
export function useNeedsYou(): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => needsYou,
    () => null,
  );
}
