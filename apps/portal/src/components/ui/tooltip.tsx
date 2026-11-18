import * as React from "react";

/**
 * The one Tooltip (M1.5). Use it only for icon-only buttons and jargon terms, with at most one short
 * sentence. It only tags the trigger (`data-tip`); the delegated layer in lib/enhance/tooltips.ts
 * shows it (500 ms hover delay, instant on keyboard focus, Esc closes, one at a time, never on
 * touch, collision-aware). Icon-only buttons still need their own `aria-label`.
 *
 * For text that may be cut off with an ellipsis, put `data-tip-truncated` on the truncating element
 * instead: its full text shows only when it is actually truncated.
 */
export function Tooltip({ label, children }: { label: string; children: React.ReactElement<Record<string, unknown>> }) {
  return React.cloneElement(children, { "data-tip": label });
}

/** Props form, for elements that are not a single child: `<button {...tip("Copy")}>`. */
export const tip = (label: string) => ({ "data-tip": label });
