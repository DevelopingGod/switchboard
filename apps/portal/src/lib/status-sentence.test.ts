import { describe, expect, it } from "vitest";
import { tStatus } from "@/i18n/status";

describe("status reasons (M3a)", () => {
  it("has a time-free sentence for every timed reason", () => {
    for (const k of ["rate_limited", "credit_limit", "timeout", "not_found", "error", "not_connected", "cooldown"] as const) {
      expect(tStatus(`now.${k}`)).not.toContain("{time}");
      expect(tStatus(`reason.${k}`, { time: "14:05" })).toContain("14:05");
    }
  });
});
