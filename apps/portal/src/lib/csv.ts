/**
 * CSV export for Metrics tables (M6). RFC 4180 quoting, CRLF line ends, and a guard against spreadsheet
 * formula injection: a text cell starting with = + - @ (or a tab / carriage return) gets a leading
 * apostrophe, so a chat title can never run as a formula when the file is opened.
 */

export type Cell = string | number | boolean | null | undefined;

const RISKY = /^[=+\-@\t\r]/;

export function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (typeof v === "string" && RISKY.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function csvFilename(name: string, range: string, today = new Date()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
  return `switchboard-${slug}-${range}-${today.toISOString().slice(0, 10)}.csv`;
}

/** Browser download (a Blob URL, revoked right after the click). */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
