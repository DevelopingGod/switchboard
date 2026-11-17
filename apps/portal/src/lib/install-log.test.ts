import { describe, expect, it } from "vitest";
import recorded from "./fixtures/install-log.entries.json";
import { collapse, failureSummary, progressOf, stageOf } from "./install-log";
import { binOf, fullPathCommand, pathFixLine, toShellPath } from "./cli-hint";
import type { LogEntry } from "./router-types";

const log = recorded as LogEntry[];
const e = (t: string, r = false, p: number | null = null): LogEntry => ({ t, r, p });

describe("recorded install log (real curl -# output assembled by hostprobe)", () => {
  it("is mostly redraws, as the raw log was", () => {
    expect(log.filter((x) => x.r).length).toBeGreaterThan(3);
  });

  it("collapses to one progress line, not one line per redraw", () => {
    const lines = collapse(log);
    expect(lines.filter((x) => x.p !== null)).toHaveLength(1);
    expect(lines.length).toBeLessThan(log.length);
    expect(lines.filter((x) => x.p !== null)[0].t).toMatch(/100\.0%$/);
    // No raw redraw is left behind: every kept entry is final except possibly the very last.
    expect(lines.slice(0, -1).every((x) => !x.r)).toBe(true);
  });

  it("reports the latest percentage as the single progress value", () => {
    expect(progressOf(log)).toBe(100);
    expect(progressOf(log.slice(0, 4))).toBeLessThan(100);
    expect(progressOf([e("Installing")])).toBeNull();
  });

  it("walks Downloading → Installing → Verifying → Done and never goes backwards", () => {
    expect(stageOf(log.slice(0, 3), "running")).toBe(0); // a live bar is always Downloading
    expect(stageOf(log, "running")).toBe(1); // download finished, text says Installing
    expect(stageOf([...log, e("Verifying checksum… ok")], "running")).toBe(2);
    expect(stageOf([...log, e("Verifying checksum… ok"), e("Installing opencode")], "running")).toBe(2);
    expect(stageOf(log, "ok")).toBe(3);
  });
});

describe("collapse", () => {
  it("lets a carriage-return line be replaced by the next line, like a terminal", () => {
    expect(collapse([e("a", true), e("b", true), e("c")]).map((x) => x.t)).toEqual(["c"]);
    expect(collapse([e("keep"), e("a", true), e("b")]).map((x) => x.t)).toEqual(["keep", "b"]);
    expect(collapse([e("x"), e("y", true)]).map((x) => x.t)).toEqual(["x", "y"]); // still redrawing
    expect(collapse([])).toEqual([]);
  });
});

describe("failureSummary", () => {
  it("picks the error line and keeps the last 20 lines without progress noise", () => {
    const lines = Array.from({ length: 30 }, (_, i) => e(`step ${i}`));
    const { summary, lines: tail } = failureSummary([
      ...lines,
      e("######## 12.0%", true, 12),
      e("curl: (22) The requested URL returned error: 404"),
      e("Install failed"),
    ]);
    expect(summary).toBe("Install failed");
    expect(tail).toHaveLength(20);
    expect(tail.at(-1)).toBe("Install failed");
    expect(tail.some((l) => l.includes("12.0%"))).toBe(false);
  });

  it("falls back to the last line, and to null for an empty log", () => {
    expect(failureSummary([e("one"), e("two")]).summary).toBe("two");
    expect(failureSummary([]).summary).toBeNull();
  });
});

describe("PATH helpers", () => {
  it("builds a one-line fix that expands $HOME at login", () => {
    expect(toShellPath("~/.opencode/bin")).toBe("$HOME/.opencode/bin");
    expect(toShellPath("/usr/local/bin")).toBe("/usr/local/bin");
    expect(pathFixLine("~/.opencode/bin")).toBe(
      `echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`,
    );
  });

  it("gives the login command by full path as a fallback", () => {
    expect(binOf("opencode auth login")).toBe("opencode");
    expect(fullPathCommand("opencode auth login", "~/.opencode/bin/opencode")).toBe("~/.opencode/bin/opencode auth login");
    expect(fullPathCommand("claude", "~/.local/bin/claude")).toBe("~/.local/bin/claude");
  });
});
