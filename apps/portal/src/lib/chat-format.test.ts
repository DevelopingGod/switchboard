import { describe, expect, it } from "vitest";
import { chipTarget, ms, targetName, usd } from "./chat-format";
import { badgesFor, privateTargets } from "./chat-targets";
import type { RouteInfo, TargetProvider, TargetsResponse } from "./router-types";

const model = (model_id: string, tags: string[], extra: object = {}) => ({
  target: `model:groq/${model_id}`,
  provider: "groq",
  model_id,
  display_name: null,
  tags,
  tag_source: "curated",
  context: 131072,
  max_output: null,
  free: true,
  paid: false,
  privacy: "no-training" as const,
  status: "available",
  test: null,
  ...extra,
});

const targets: TargetsResponse = {
  preset: "balanced",
  aliases: [
    { target: "model:fast", alias: "fast", label: "Groq · gpt-oss-120b", available: true, reason: null, local: false, free_tier: true, paid: false, privacy: "no-training" },
    { target: "model:local", alias: "local", label: "Ollama · qwen3:4b", available: true, reason: null, local: true, free_tier: true, paid: false, privacy: "local" },
  ],
  providers: [
    { provider: "groq", name: "Groq", local: false, privacy: "no-training", models: [model("openai/gpt-oss-120b", ["chat", "code", "reasoning"])] },
    { provider: "ollama", name: "Ollama", local: true, privacy: "local", models: [{ ...model("qwen3:4b", ["chat"]), provider: "ollama", target: "model:ollama/qwen3:4b" }] },
  ],
};

describe("chat format", () => {
  it("formats money and time", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.00004)).toBe("< $0.0001");
    expect(usd(0.0012)).toBe("$0.0012");
    expect(usd(1.5)).toBe("$1.50");
    expect(usd(null)).toBe("—");
    expect(ms(340)).toBe("340 ms");
    expect(ms(45311)).toBe("45.3 s");
  });
  it("labels the chip with the model, falling back to the target", () => {
    expect(chipTarget({ label: "Groq · gpt-oss-120b", target: "model:fast" } as RouteInfo)).toBe("Groq · gpt-oss-120b");
    expect(chipTarget({ label: null, target: "model:fast" } as RouteInfo)).toBe("model:fast");
  });
  it("names targets for the picker trigger", () => {
    expect(targetName("auto", targets)).toBeNull();
    expect(targetName("model:fast", targets)).toBe("fast");
    expect(targetName("model:groq/openai/gpt-oss-120b", targets)).toBe("openai/gpt-oss-120b");
    expect(targetName("model:smart-free", null)).toBe("smart-free");
  });
  it("limits Private to local targets", () => {
    expect([...privateTargets(targets)].sort()).toEqual(["auto", "model:local", "model:ollama/qwen3:4b"]);
  });
  it("badges models like the Connections cards", () => {
    const b = badgesFor(targets.providers[0] as TargetProvider);
    expect(b.get("openai/gpt-oss-120b")).toContain("code");
    expect(b.get("openai/gpt-oss-120b")).toContain("free");
  });
});
