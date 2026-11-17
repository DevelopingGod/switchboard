import { describe, expect, it } from "vitest";
import { neededProviders } from "@/lib/wizard";
import { splitHint } from "@/lib/cli-hint";

const map = {
  chat: [{ provider: "groq", paid: false }, { provider: "cerebras", paid: false }],
  writing: [{ provider: "gemini", paid: false }, { provider: "openrouter", paid: false }],
  images: [{ provider: "gemini", paid: false }, { provider: "xai", paid: true }],
  video: [{ provider: "xai", paid: true }],
};

describe("neededProviders", () => {
  it("only lists providers the chosen goals use, de-duplicated, with the goals that need them", () => {
    const n = neededProviders(["writing", "images"], map);
    expect(n.map((x) => x.provider)).toEqual(["gemini", "openrouter", "xai"]);
    expect(n.find((x) => x.provider === "gemini")?.for).toEqual(["writing", "images"]);
  });

  it("flags paid providers and returns nothing when no goal is chosen", () => {
    expect(neededProviders(["video"], map)).toEqual([{ provider: "xai", paid: true, for: ["video"] }]);
    expect(neededProviders([], map)).toEqual([]);
  });

  it("ignores goals the router does not know", () => {
    expect(neededProviders(["nope"], map)).toEqual([]);
  });
});

describe("splitHint", () => {
  it("separates the command from the explanatory note", () => {
    expect(splitHint("claude  (then /login in the browser)")).toEqual({ command: "claude", note: "then /login in the browser" });
    expect(splitHint("codex login")).toEqual({ command: "codex login", note: null });
    expect(splitHint(null)).toEqual({ command: "", note: null });
  });
});
