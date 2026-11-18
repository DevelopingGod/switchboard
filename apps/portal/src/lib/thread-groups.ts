import type { ChatThread } from "./router-types";

/** Sidebar groups (M1.5), in display order. Pinned threads leave their date group. */
export type GroupId = "pinned" | "today" | "yesterday" | "week" | "older";
export const GROUP_ORDER: GroupId[] = ["pinned", "today", "yesterday", "week", "older"];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86_400_000;

/** Whole local calendar days between `iso` and `now` (0 = today, 1 = yesterday). */
export function daysAgo(iso: string, now: Date = new Date()): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY);
}

export function groupOf(th: ChatThread, now: Date = new Date()): GroupId {
  if (th.pinned) return "pinned";
  const d = daysAgo(th.updated_at, now);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return "week";
  return "older";
}

/** Non-empty groups in order; threads keep the router's order (newest first) inside each group. */
export function groupThreads(threads: ChatThread[], now: Date = new Date()): { id: GroupId; threads: ChatThread[] }[] {
  const by = new Map<GroupId, ChatThread[]>();
  for (const th of threads) {
    const g = groupOf(th, now);
    by.set(g, [...(by.get(g) ?? []), th]);
  }
  return GROUP_ORDER.filter((g) => by.has(g)).map((id) => ({ id, threads: by.get(id)! }));
}

/** Case- and accent-insensitive title filter for the sidebar search. */
export function filterThreads(threads: ChatThread[], query: string): ChatThread[] {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = norm(query.trim());
  return q ? threads.filter((th) => norm(th.title || "").includes(q)) : threads;
}

/** Chat date separators: "today" / "yesterday" or a short fixed-locale date (same on server and client). */
export function dayKey(iso: string, now: Date = new Date()): { kind: "today" | "yesterday" } | { kind: "date"; text: string } {
  const d = daysAgo(iso, now);
  if (d <= 0) return { kind: "today" };
  if (d === 1) return { kind: "yesterday" };
  const date = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return { kind: "date", text: new Intl.DateTimeFormat("en-GB", opts).format(date) };
}

/** Local calendar day of a timestamp, for "does this message start a new day?". */
export const localDay = (iso: string) => startOfDay(new Date(iso));
