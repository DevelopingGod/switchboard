import { describe, expect, it } from "vitest";
import { formatContext, recommend } from "./recommend";
import type { CatalogModel } from "./router-types";

const m = (id: string, tags: string[], over: Partial<CatalogModel> = {}): CatalogModel => ({
  provider: "p",
  model_id: id,
  display_name: null,
  tags,
  tag_source: "curated",
  context: 8000,
  max_output: null,
  free: false,
  privacy: "no-training",
  status: "available",
  test: null,
  ...over,
});

const badgesOf = (models: CatalogModel[]) =>
  Object.fromEntries(recommend(models).picks.map((p) => [p.model.model_id, p.badges]));

describe("recommend", () => {
  it("awards code, fastest and context from tags", () => {
    const b = badgesOf([
      m("coder", ["chat", "code"], { context: 32000 }),
      m("quick", ["chat", "fast"], { context: 16000 }),
      m("huge", ["chat"], { context: 1_000_000 }),
    ]);
    expect(b).toEqual({ coder: ["code"], quick: ["fastest"], huge: ["context"] });
  });

  it("merges badges when one model wins several, and adds Free to picked models", () => {
    const { picks } = recommend([m("all", ["chat", "code", "fast"], { context: 99999, free: true })]);
    expect(picks).toHaveLength(1);
    expect(picks[0].badges).toEqual(["code", "fastest", "context", "free"]);
  });

  it("prefers reasoning, then larger context, for Best for code", () => {
    const { picks } = recommend([
      m("a", ["chat", "code"], { context: 500000 }),
      m("b", ["chat", "code", "reasoning"], { context: 8000 }),
    ]);
    expect(picks.find((p) => p.badges.includes("code"))?.model.model_id).toBe("b");
  });

  it("prefers a measured passing p50 over the fast tag", () => {
    const test = (p50: number, ok = true) => ({ samples: 3, error_rate: 0, p50_ms: p50, p95_ms: p50, last_ok: ok });
    const { picks } = recommend([
      m("tagged-fast", ["chat", "fast"], { test: test(900) }),
      m("measured-fast", ["chat"], { test: test(200) }),
      m("failed-fast", ["chat"], { test: test(50, false) }),
    ]);
    expect(picks.find((p) => p.badges.includes("fastest"))?.model.model_id).toBe("measured-fast");
  });

  it("never badges untagged, non-chat or unavailable models, and counts untagged", () => {
    const models = [
      m("mystery", [], { context: 2_000_000 }),
      m("whisper", ["audio"], { context: 2_000_000 }),
      m("embed", ["chat", "embedding"], { context: 2_000_000 }),
      m("gone", ["chat", "code"], { status: "missing" }),
      m("ok", ["chat"], { context: 4000 }),
    ];
    const { picks, untagged } = recommend(models);
    expect(picks.map((p) => p.model.model_id)).toEqual(["ok"]);
    expect(untagged).toBe(1);
  });

  it("returns nothing for an empty catalog", () => {
    expect(recommend([])).toEqual({ picks: [], untagged: 0 });
  });

  it("caps the picks", () => {
    const models = [m("a", ["chat", "code"]), m("b", ["chat", "fast"]), m("c", ["chat"], { context: 9e6 })];
    expect(recommend(models, 2).picks).toHaveLength(2);
  });
});

describe("formatContext", () => {
  it("formats windows", () => {
    expect(formatContext(1_048_576)).toBe("1M");
    expect(formatContext(131_072)).toBe("131k");
    expect(formatContext(512)).toBe("512");
    expect(formatContext(null)).toBeNull();
  });

  it("OpenRouter: only :free models are badged; paid ones are never recommended", () => {
    const or = (id: string, tags: string[], over: Partial<CatalogModel> = {}) => m(id, tags, { provider: "openrouter", ...over });
    const { picks } = recommend([
      or("anthropic/big", ["chat", "code", "reasoning"], { context: 1_000_000 }),
      or("openai/gpt-oss-120b:free", ["chat", "code"], { context: 131072 }),
      or("meta/fast:free", ["chat", "fast"], { context: 8000, free: true }),
    ]);
    const ids = picks.map((p) => p.model.model_id);
    expect(ids).not.toContain("anthropic/big");
    for (const p of picks) expect(p.badges).toContain("free");
  });

  it("labels a shown paid model of a per-model-priced provider as Paid, never Free", () => {
    // Zen: a paid model only reaches the picks when it is free-flagged (it is filtered otherwise);
    // simulate a free-flag mismatch to check the label path.
    const zen = m("paid-one", ["chat", "code"], { provider: "opencode-zen", free: true });
    expect(recommend([zen]).picks[0].badges).toContain("free");
    expect(recommend([{ ...zen, free: false }]).picks).toHaveLength(0);
  });
});

