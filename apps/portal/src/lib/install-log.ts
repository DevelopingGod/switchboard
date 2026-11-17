import type { LogEntry } from "./router-types";

/**
 * Install-log logic, kept free of React so it can be tested against recorded output.
 * hostprobe splits raw installer output on "\r" and "\n": an entry with `r: true` was redrawn
 * (curl's progress bar), so the next entry replaces it, like a terminal would.
 */

export const STAGES = ["download", "install", "verify", "done"] as const;
export type Stage = (typeof STAGES)[number];

/** A "\r" redraw is replaced by whatever comes next. */
export function collapse(entries: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of entries) {
    if (out.length && out[out.length - 1].r) out[out.length - 1] = e;
    else out.push(e);
  }
  return out;
}

/** The most recent download percentage, or null when the installer printed no progress. */
export function progressOf(entries: LogEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].p !== null) return Math.round(entries[i].p!);
  return null;
}

const KEYWORDS: [Stage, RegExp][] = [
  ["verify", /verif|checksum|sha-?256|integrity|signature/i],
  ["download", /download|fetch/i],
  ["install", /install|extract|unpack|setting up|moving|linking|adding|copying/i],
];

/**
 * Where the install is. While a progress bar is live the stage is always Downloading; otherwise it
 * is the furthest stage the text has reached (never goes backwards), and Done only on success.
 */
export function stageOf(entries: LogEntry[], phase: "running" | "ok" | "failed" | "cancelled" | "timeout"): number {
  if (phase === "ok") return STAGES.indexOf("done");
  const live = collapse(entries);
  const last = live[live.length - 1];
  if (phase === "running" && last && last.p !== null && last.p < 100) return 0;
  let furthest = 0;
  for (const e of live) {
    if (e.p !== null) continue;
    const hit = KEYWORDS.find(([, re]) => re.test(e.t));
    if (hit) furthest = Math.max(furthest, STAGES.indexOf(hit[0]));
  }
  return furthest;
}

const ERROR_LINE = /error|fail|not found|denied|cannot|can't|unable|refus|invalid|timed out/i;

/** The line that best says what went wrong, plus the tail of the log (default 20 lines). */
export function failureSummary(entries: LogEntry[], tail = 20): { summary: string | null; lines: string[] } {
  const lines = collapse(entries)
    .filter((e) => e.p === null)
    .map((e) => e.t);
  const summary = [...lines].reverse().find((l) => ERROR_LINE.test(l)) ?? lines[lines.length - 1] ?? null;
  return { summary, lines: lines.slice(-tail) };
}
