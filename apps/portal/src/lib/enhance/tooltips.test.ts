import { describe, expect, it } from "vitest";
import { CLOSE_DELAY_MS, OPEN_DELAY_MS, placeTip } from "./tooltips";

const vp = { width: 1280, height: 900 };
const tip = { width: 120, height: 30 };

describe("tooltip placement", () => {
  it("goes above the trigger, centred", () => {
    expect(placeTip({ top: 400, bottom: 440, left: 600, width: 40 }, tip, vp)).toEqual({ x: 560, y: 362, side: "top" });
  });
  it("flips below near the top edge (e.g. the top nav)", () => {
    const p = placeTip({ top: 12, bottom: 52, left: 600, width: 40 }, tip, vp);
    expect(p.side).toBe("bottom");
    expect(p.y).toBe(60);
  });
  it("is clamped inside the viewport horizontally", () => {
    expect(placeTip({ top: 400, bottom: 440, left: 2, width: 20 }, tip, vp).x).toBe(8);
    expect(placeTip({ top: 400, bottom: 440, left: 1270, width: 10 }, tip, vp).x).toBe(1280 - 120 - 8);
  });
  it("uses the agreed delays", () => {
    expect(OPEN_DELAY_MS).toBe(500);
    expect(CLOSE_DELAY_MS).toBe(100);
  });
});
