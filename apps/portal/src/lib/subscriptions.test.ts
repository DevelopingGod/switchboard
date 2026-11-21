import { describe, expect, it } from "vitest";
import { resetTime, sourceText, windowPct, windowText } from "./subscription-format";
import { customRangeProblem, rangeTag } from "./metrics-types";
import { badgeOf, isActive } from "./job-format";
import type { UsageWindowView } from "./router-types";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const w = (over: Partial<UsageWindowView> = {}): UsageWindowView => ({
  window: "five_hour",
  label: "5-hour",
  hours: 5,
  used: null,
  resets_at: null,
  limited: false,
  source: "estimate",
  runs: 0,
  seen_at: null,
  ...over,
});

describe("usage windows (M6.5)", () => {
  it("says a reported share plainly, with the reset time", () => {
    const text = windowText(w({ used: 0.7, source: "reported", resets_at: "2026-11-20T14:20:00Z" }), NOW);
    expect(text).toMatch(/^70% of this 5-hour window · resets /);
    expect(text).toContain(resetTime("2026-11-20T14:20:00Z", NOW));
  });
  it("marks an estimate with ~ and never invents a share without a calibration", () => {
    expect(windowText(w({ used: 0.42 }), NOW)).toMatch(/^~42% of this 5-hour window/);
    expect(windowText(w({ runs: 3 }), NOW)).toBe("3 run(s) in this 5-hour window, no reading yet");
    expect(windowText(w(), NOW)).toBe("No reading for the 5-hour window yet");
    expect(windowPct(w())).toBeNull();
    expect(windowText(null)).toBe("No usage window reported yet");
  });
  it("says when a limit is reached", () => {
    expect(windowText(w({ limited: true, used: 1, resets_at: "2026-11-20T14:20:00Z" }), NOW)).toMatch(/^5-hour limit reached · resets /);
    expect(windowText(w({ limited: true }), NOW)).toBe("5-hour limit reached");
  });
  it("adds the weekday when the reset isn't today", () => {
    const later = resetTime("2026-11-23T09:00:00Z", NOW);
    expect(later).not.toBe(resetTime("2026-11-23T09:00:00Z", Date.parse("2026-11-23T08:00:00Z")));
  });
  it("labels the source", () => {
    expect(sourceText(w({ source: "reported" }))).toBe("reported by the CLI");
    expect(sourceText(w())).toBe("estimate");
  });
  it("shows a waiting job as its own state, still active", () => {
    expect(badgeOf("waiting_reset")).toBe("waiting");
    expect(isActive("waiting_reset")).toBe(true);
  });
});

describe("custom Metrics range (M6 carry-over)", () => {
  const today = "2026-11-21";
  it("accepts a valid range and tags CSV names with it", () => {
    expect(customRangeProblem("2026-11-01", "2026-11-20", today)).toBeNull();
    expect(rangeTag("custom", "2026-11-01", "2026-11-20")).toBe("2026-11-01_2026-11-20");
    expect(rangeTag("7d")).toBe("7d");
  });
  it("refuses what the router refuses", () => {
    expect(customRangeProblem("", "2026-11-20", today)).toBe("missing");
    expect(customRangeProblem("2026-11-20", "2026-11-01", today)).toBe("order");
    expect(customRangeProblem("2026-12-01", "2026-12-02", today)).toBe("future");
    expect(customRangeProblem("2025-01-01", "2026-11-20", today)).toBe("long");
    expect(customRangeProblem("2025-11-21", "2026-11-21", today)).toBeNull(); // 366 days
  });
});
