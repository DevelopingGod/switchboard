import type { SystemSummary } from "./router-types";
import { tShell } from "@/i18n/shell";

/** The footer's quota words (M3a): the provider closest to a free limit ("Groq 72% of today's
 * limit") once one is at 50% or more, else the overall state. */
export function footerQuota(q: SystemSummary["quota"] | undefined): string {
  const top = q?.top;
  if (top) return tShell(`footer.quota.${top.window}`, { name: top.name, pct: Math.round(top.fraction * 100) });
  return tShell(`footer.quota.${q?.status ?? "ok"}`);
}
