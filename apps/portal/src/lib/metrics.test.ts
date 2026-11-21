import { describe, expect, it } from "vitest";
import { cell, csvFilename, toCsv } from "./csv";
import { count, ms, pct, slotLabel, ticks, usd, when } from "./metrics-format";

describe("csv", () => {
  it("quotes per RFC 4180 and ends lines with CRLF", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], [1.5, null]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n1.5,\r\n');
  });
  it("neutralises spreadsheet formulas in text cells", () => {
    for (const v of ["=SUM(A1:A3)", "+1", "-2+3", "@cmd", "\tx"]) expect(cell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(cell(-2)).toBe("-2"); // numbers stay numbers
    expect(cell(Number.NaN)).toBe("");
  });
  it("names files predictably", () => {
    expect(csvFilename("Top requests!", "7d", new Date("2026-11-21T10:00:00Z"))).toBe("switchboard-top-requests-7d-2026-11-21.csv");
  });
});

describe("format", () => {
  it("money, counts, percents, durations", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(-1.5)).toBe("−$1.50");
    expect(usd(12345)).toBe("$12,345");
    expect(usd(null)).toBe("—");
    expect(count(12345)).toBe("12k");
    expect(count(2_500_000)).toBe("2.5M");
    expect(pct(0.625)).toBe("63%");
    expect(ms(850)).toBe("850 ms");
    expect(ms(2450)).toBe("2.5 s");
    expect(ms(null)).toBe("—");
  });
  it("slot labels and times in the viewer's zone", () => {
    expect(slotLabel("2026-11-21T14:00:00", "hour")).toBe("14:00");
    expect(slotLabel("2026-11-02T00:00:00", "day")).toBe("2 Nov");
    const now = new Date("2026-11-21T06:00:00Z");
    expect(when("2026-11-21T12:30:00Z", "Asia/Kolkata", now)).toBe("today 18:00");
    expect(when("2026-11-22T00:00:00Z", "UTC", now)).toBe("Sun 00:00");
  });
  it("nice ticks cover the maximum in round steps", () => {
    expect(ticks(0)).toEqual([0]);
    expect(ticks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(ticks(0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    const t = ticks(1234);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1234);
    expect(t.length).toBeLessThanOrEqual(6);
  });
});
