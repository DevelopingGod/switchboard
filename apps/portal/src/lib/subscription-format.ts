import type { UsageWindowView } from "./router-types";
import { tSubs } from "@/i18n/subscriptions";

/** Local "14:20" for a reset time; with the weekday when it isn't today ("Sat 09:00"). */
export function resetTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** 0..100 for a Dial, or null when the share is unknown. */
export const windowPct = (w: UsageWindowView | null | undefined): number | null =>
  w && w.used != null ? Math.max(0, Math.min(100, Math.round(w.used * 100))) : null;

/**
 * One plain sentence for a usage window: "~70% of this 5-hour window · resets 14:20". An estimate is never
 * shown as a bare percentage without the "~"; with no calibration it says how many runs, never a guess.
 */
export function windowText(w: UsageWindowView | null | undefined, now = Date.now()): string {
  if (!w) return tSubs("window.none");
  const at = resetTime(w.resets_at, now);
  if (w.limited) return at ? tSubs("window.limited", { label: w.label, at }) : tSubs("window.limitedNoTime", { label: w.label });
  const pct = windowPct(w);
  if (pct == null) return w.runs ? tSubs("window.runsOnly", { n: w.runs, label: w.label }) : tSubs("window.noReading", { label: w.label });
  const share = w.source === "estimate" ? `~${pct}%` : `${pct}%`;
  return at ? tSubs("window.used", { share, label: w.label, at }) : tSubs("window.usedNoTime", { share, label: w.label });
}

export const sourceText = (w: UsageWindowView | null | undefined) =>
  !w ? "" : w.source === "reported" ? tSubs("source.reported") : tSubs("source.estimate");
