import { describe, expect, it } from "vitest";
import { plainReason } from "./chat-format";
import type { RouteInfo } from "./router-types";

const base = { matched_by: "default", intent: "chat", private: false, skipped: [], cost_usd: 0, free_tier: true, sensitive: null } as unknown as RouteInfo;

describe("plainReason (Simple mode's Why this?)", () => {
  it("picks one plain reason", () => {
    expect(plainReason(base)).toBe("quick");
    expect(plainReason({ ...base, cost_usd: 0.01, free_tier: false })).toBe("everyday");
    expect(plainReason({ ...base, matched_by: "manual" })).toBe("manual");
    expect(plainReason({ ...base, matched_by: "slash" })).toBe("slash");
    expect(plainReason({ ...base, matched_by: "private", private: true })).toBe("private");
    expect(plainReason({ ...base, matched_by: "auto_private" })).toBe("sensitive");
    expect(plainReason({ ...base, intent: "code", matched_by: "intent" })).toBe("code");
    expect(plainReason({ ...base, skipped: [{ target: "model:fast", label: "Groq", code: "cooldown", reason: "Rate limited (429)" }] })).toBe("busy");
  });
});
