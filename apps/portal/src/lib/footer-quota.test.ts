import { describe, expect, it } from "vitest";
import { footerQuota } from "./footer-quota";
import type { QuotaUsage, SystemSummary } from "./router-types";

const q = (top: Partial<QuotaUsage> | null, status: SystemSummary["quota"]["status"] = "limited"): SystemSummary["quota"] => ({
  status,
  daily_cap_usd: 1,
  daily_cap_used: 0,
  cooling_down: [],
  credits_low: [],
  credits_out: [],
  top: top
    ? { provider: "groq", name: "Groq", model: null, fraction: 0.72, window: "day", kind: "requests", used: 720, limit: 1000, resets_at: null, source: "counter", estimate: false, ...top }
    : null,
});

describe("footerQuota", () => {
  it("names the provider closest to its limit", () => {
    expect(footerQuota(q({}))).toBe("Groq 72% of today’s limit");
    expect(footerQuota(q({ window: "minute", fraction: 0.905 }))).toBe("Groq 91% of its per-minute limit");
  });
  it("falls back to the overall state", () => {
    expect(footerQuota(q(null, "ok"))).toBe("Quota OK");
    expect(footerQuota(q(null, "blocked"))).toBe("Daily cap reached");
    expect(footerQuota(undefined)).toBe("Quota OK");
  });
});
