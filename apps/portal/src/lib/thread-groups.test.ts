import { describe, expect, it } from "vitest";
import { dayKey, filterThreads, groupThreads } from "./thread-groups";
import type { ChatThread } from "./router-types";

const now = new Date(2026, 10, 18, 10, 0); // 18 Nov 2026, 10:00 local
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).toISOString();
const th = (id: string, updated: string, over: Partial<ChatThread> = {}): ChatThread => ({
  id,
  title: id,
  title_source: "user",
  private: false,
  pinned: false,
  created_at: updated,
  updated_at: updated,
  ...over,
});

describe("groupThreads", () => {
  it("groups by local day: pinned, today, yesterday, previous 7 days, older", () => {
    const groups = groupThreads(
      [
        th("a", at(2026, 10, 18, 0)), // just after midnight: today
        th("b", at(2026, 10, 17, 23)), // late yesterday
        th("c", at(2026, 10, 12)), // 6 days ago
        th("d", at(2026, 10, 11)), // 7 days ago: older
        th("e", at(2025, 0, 1), { pinned: true }),
      ],
      now,
    );
    expect(groups.map((g) => [g.id, g.threads.map((t) => t.id)])).toEqual([
      ["pinned", ["e"]],
      ["today", ["a"]],
      ["yesterday", ["b"]],
      ["week", ["c"]],
      ["older", ["d"]],
    ]);
  });

  it("omits empty groups", () => {
    expect(groupThreads([th("a", at(2026, 10, 18))], now).map((g) => g.id)).toEqual(["today"]);
    expect(groupThreads([], now)).toEqual([]);
  });
});

describe("filterThreads", () => {
  it("matches case- and accent-insensitively", () => {
    const list = [th("Café plans", at(2026, 10, 18)), th("Launch post", at(2026, 10, 18))];
    expect(filterThreads(list, "cafe").map((t) => t.id)).toEqual(["Café plans"]);
    expect(filterThreads(list, "  ")).toHaveLength(2);
  });
});

describe("dayKey", () => {
  it("labels today, yesterday, then a short date (with the year when different)", () => {
    expect(dayKey(at(2026, 10, 18), now)).toEqual({ kind: "today" });
    expect(dayKey(at(2026, 10, 17), now)).toEqual({ kind: "yesterday" });
    expect(dayKey(at(2026, 10, 10), now)).toEqual({ kind: "date", text: "Tue 10 Nov" });
    expect(dayKey(at(2025, 11, 31), now)).toEqual({ kind: "date", text: "Wed, 31 Dec 2025" });
  });
});
