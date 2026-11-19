import { describe, expect, it } from "vitest";
import {
  addRule, countChanges, unsavedCount, disableRule, pathLabel, problemsUnder, resetRule, setPath, setRuleField, targetLabel, whenSummary,
} from "./rules-model";
import type { RulesFile } from "./router-types";

const base = {
  rules: [
    { id: "writing", when: { intent: "writing" }, target: "model:smart-free", fallbacks: ["model:fast"], temperature: 0.8 },
    { id: "default", when: {}, target: "model:fast" },
  ],
} as unknown as RulesFile;

describe("setPath", () => {
  it("sets, removes and prunes emptied parents without touching the input", () => {
    const a = {};
    const b = setPath(a, ["rules", "x", "target"], "model:fast");
    expect(b).toEqual({ rules: { x: { target: "model:fast" } } });
    expect(a).toEqual({});
    expect(setPath(b, ["rules", "x", "target"], undefined)).toEqual({});
  });
});

describe("setRuleField", () => {
  it("stores a change and drops it again when the value goes back to the base", () => {
    const a = setRuleField({}, base, "writing", "target", "model:fast");
    expect(a).toEqual({ rules: { writing: { target: "model:fast" } } });
    expect(setRuleField(a, base, "writing", "target", "model:smart-free")).toEqual({});
  });
  it("compares chains and objects by value", () => {
    expect(setRuleField({}, base, "writing", "fallbacks", ["model:fast"])).toEqual({});
    expect(setRuleField({}, base, "writing", "fallbacks", [])).toEqual({ rules: { writing: { fallbacks: [] } } });
    expect(setRuleField({}, base, "writing", "when", { intent: "writing" })).toEqual({});
  });
  it("an override can't remove a field the base sets (merge only adds); clearing leaves the document unchanged", () => {
    expect(setRuleField({}, base, "writing", "temperature", undefined)).toEqual({});
  });
  it("a new rule keeps every field it is given", () => {
    const o = addRule({}, "mine", { when: { intent: "chat" }, target: "model:fast", before: "default" });
    expect(o.rules!.mine).toEqual({ when: { intent: "chat" }, target: "model:fast", before: "default" });
    expect(setRuleField(o, base, "mine", "target", "model:local").rules!.mine.target).toBe("model:local");
  });
});

describe("rule lifecycle", () => {
  it("disable and reset", () => {
    const o = disableRule({}, "writing");
    expect(o.rules!.writing).toEqual({ disabled: true });
    expect(resetRule(o, "writing")).toEqual({});
  });
  it("counts leaf edits", () => {
    expect(countChanges({})).toBe(0);
    expect(countChanges({ rules: { a: { target: "x", fallbacks: ["y"] } }, slash: { q: "default" } })).toBe(3);
  });
});

describe("unsavedCount", () => {
  it("counts the leaves that differ from the saved version, in both directions", () => {
    const saved = { rules: { writing: { target: "model:fast", temperature: 0.3 } } };
    expect(unsavedCount(saved, saved)).toBe(0);
    expect(unsavedCount({}, saved)).toBe(2); // two removals
    expect(unsavedCount({ rules: { writing: { target: "model:local", temperature: 0.3 } } }, saved)).toBe(1);
    expect(unsavedCount({ ...saved, slash: { q: "default" } }, saved)).toBe(1);
  });
});

describe("labels", () => {
  it("summarises conditions and targets in plain words", () => {
    expect(whenSummary({})).toBe("Everything else");
    expect(whenSummary({ intent: "code", size: "large" })).toBe("Code, large scope");
    expect(whenSummary({ private: true })).toBe("Private chat");
    expect(whenSummary({ command: "bulk" })).toBe("/bulk");
    expect(targetLabel("model:fast")).toBe("fast");
    expect(targetLabel("best:code")).toBe("best for code");
    expect(targetLabel("agent:claude-code")).toBe("agent claude-code");
    expect(pathLabel("rules.writing.target")).toBe("Rule writing · target");
    expect(pathLabel("classifier.routes.sensitive_health.description")).toBe("Classifier route sensitive_health · description");
    expect(pathLabel("slash.q")).toBe("slash · q");
  });
  it("finds problems under a prefix", () => {
    const ps = [{ path: "rules.a.target", message: "x" }, { path: "rules.ab.target", message: "y" }, { path: "rules.a.fallbacks[1]", message: "z" }];
    expect(problemsUnder(ps, "rules.a").map((p) => p.message)).toEqual(["x", "z"]);
  });
});

// --- contract: the same cases run against the router's Python merge (test_rules_overrides.py) ---------
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeOverrides } from "./rules-model";

interface Case {
  name: string;
  overrides: object;
  rule_ids?: string[];
  check?: Record<string, unknown>;
}
const contract = JSON.parse(
  readFileSync(join(__dirname, "../../../../services/router/tests/fixtures/rules_merge_cases.json"), "utf8"),
) as { base: RulesFile; cases: Case[] };

const at = (doc: Record<string, unknown>, path: string): unknown => {
  const [head, ...rest] = path.split(".");
  if (head === "rules") return (doc.rules as { id: string }[]).find((r) => r.id === rest[0]);
  return rest.reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], doc[head]);
};

describe("mergeOverrides matches the router's merge (shared contract cases)", () => {
  for (const c of contract.cases) {
    it(c.name, () => {
      const before = structuredClone(contract.base);
      const out = mergeOverrides(contract.base, c.overrides) as unknown as Record<string, unknown>;
      expect(contract.base).toEqual(before); // the base is never changed
      if (c.rule_ids) expect((out.rules as { id: string }[]).map((r) => r.id)).toEqual(c.rule_ids);
      for (const [path, want] of Object.entries(c.check ?? {})) expect(at(out, path), path).toEqual(want);
    });
  }
});
