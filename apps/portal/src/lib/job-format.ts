import type { Status } from "@/components/kit/StatusBadge";
import type { JobStatus, JobView } from "./router-types";

/** Job state → the kit's StatusBadge state (icon + text + colour). */
export function badgeOf(s: JobStatus): Status {
  return s === "needs_approval" ? "needsApproval" : s;
}

export const usd = (v: number) => (v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);

/** The cost line a job shows: real spend, list price, or "cost not reported". */
export function costSummary(j: Pick<JobView, "cost_reported" | "list_price_usd" | "cost_usd">): { kind: "free" | "paid" | "unreported"; listed: string; spent: string } {
  if (!j.cost_reported) return { kind: "unreported", listed: "", spent: usd(j.cost_usd) };
  return { kind: j.cost_usd > 0 ? "paid" : "free", listed: usd(j.list_price_usd), spent: usd(j.cost_usd) };
}

/** Budget used, 0–100 (list price against the job's budget). */
export function budgetPct(j: Pick<JobView, "list_price_usd" | "budget_list_usd">): number {
  return j.budget_list_usd > 0 ? Math.min(100, Math.round((j.list_price_usd / j.budget_list_usd) * 100)) : 0;
}

export const ACTIVE: readonly JobStatus[] = ["queued", "running", "needs_approval"];
export const isActive = (s: JobStatus) => ACTIVE.includes(s);

/** Plain git commands to review and merge a job's branch (Switchboard never runs them). */
export function mergeCommands(branch: string, path?: string | null): { log: string; diff: string; merge: string } {
  const cd = path ? `cd ${shellQuote(path)} && ` : "";
  return {
    log: `${cd}git log --oneline HEAD..${branch}`,
    diff: `${cd}git diff HEAD...${branch}`,
    merge: `${cd}git merge --no-ff ${branch}`,
  };
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "12 s", "4 min", "2 h 5 min" between two ISO times (or until now). */
export function duration(from: string | null, to?: string | null, now = Date.now()): string {
  if (!from) return "";
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
