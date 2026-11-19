import type { Overrides, RuleDef, RuleProblem, RulesFile } from "./router-types";

/**
 * Pure helpers behind the Rules editor (M3b). The editor holds one `Overrides` document; every edit
 * goes through here so that (a) a value equal to the base is never stored (reverting a field removes
 * the override) and (b) empty objects don't pile up. Validation itself is the router's (ADR 0004).
 */

type Json = Record<string, unknown>;

const isEmpty = (v: unknown) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Json).length === 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A copy of `doc` with `path` set (or removed when `value` is undefined); emptied parents are pruned. */
export function setPath<T extends object>(doc: T, path: (string | number)[], value: unknown): T {
  const root: Json = structuredClone(doc as Json);
  let node = root;
  const trail: [Json, string][] = [];
  for (const key of path.slice(0, -1)) {
    const k = String(key);
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    trail.push([node, k]);
    node = node[k] as Json;
  }
  const last = String(path[path.length - 1]);
  if (value === undefined) delete node[last];
  else node[last] = value;
  for (const [parent, key] of trail.reverse()) {
    if (isEmpty(parent[key])) delete parent[key];
    else break;
  }
  return root as T;
}

export const RULE_FIELDS = ["when", "target", "fallbacks", "temperature", "autonomy", "max_cost_usd", "job"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export function baseRule(base: RulesFile, id: string): RuleDef | undefined {
  return base.rules.find((r) => r.id === id);
}

export const isNewRule = (base: RulesFile, id: string) => !baseRule(base, id);
export const isDisabled = (ov: Overrides, id: string) => ov.rules?.[id]?.disabled === true;
export const isEdited = (ov: Overrides, id: string) => !!ov.rules?.[id];

/** Sets one field of a rule. Equal to the base value -> the override is removed. */
export function setRuleField(ov: Overrides, base: RulesFile, id: string, field: RuleField, value: unknown): Overrides {
  const b = baseRule(base, id);
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0 && field !== "fallbacks");
  if (b && (empty ? b[field] === undefined : same(b[field], value))) return setPath(ov, ["rules", id, field], undefined);
  return setPath(ov, ["rules", id, field], empty ? undefined : value);
}

export const resetRule = (ov: Overrides, id: string): Overrides => setPath(ov, ["rules", id], undefined);
export const disableRule = (ov: Overrides, id: string): Overrides => setPath(ov, ["rules", id], { disabled: true });
export const addRule = (ov: Overrides, id: string, rule: Omit<RuleDef, "id"> & { before?: string }): Overrides =>
  setPath(ov, ["rules", id], rule);

/** How many separate edits the document holds (leaf values), for the "N changes" label. */
export function countChanges(ov: Overrides): number {
  const walk = (v: unknown): number =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.values(v as Json).reduce<number>((n, x) => n + walk(x), 0) : 1;
  return isEmpty(ov) ? 0 : walk(ov);
}

/** Leaf paths where the two documents differ: the "N unsaved changes" count (draft vs the saved version). */
export function unsavedCount(draft: Overrides, saved: Overrides): number {
  const flat = (v: unknown, p = ""): Record<string, string> =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as Json).length
      ? Object.entries(v as Json).reduce((o, [k, x]) => ({ ...o, ...flat(x, p ? `${p}.${k}` : k) }), {})
      : p ? { [p]: JSON.stringify(v) } : {};
  const a = flat(draft), b = flat(saved);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).length;
}

export const hasChanges = (a: Overrides, b: Overrides) => !same(a, b);

/** `{ intent: "code", size: "large" }` -> "Code, large"; `{}` -> "Everything else". */
export function whenSummary(when: RuleDef["when"]): string {
  const w = when ?? {};
  const parts: string[] = [];
  if (w.private === true) parts.push("Private chat");
  if (typeof w.command === "string") parts.push(`/${w.command}`);
  if (typeof w.intent === "string") parts.push(w.intent[0].toUpperCase() + w.intent.slice(1));
  if (typeof w.size === "string") parts.push(`${w.size} scope`);
  if (typeof w.quality === "string") parts.push(`${w.quality} quality`);
  return parts.length ? parts.join(", ") : "Everything else";
}

/** `model:fast` -> "fast"; `best:code` -> "best for code"; `agent:x` -> "agent x". */
export function targetLabel(t: string): string {
  const [kind, ...rest] = t.split(":");
  const name = rest.join(":");
  return kind === "model" ? name : kind === "best" ? `best for ${name}` : `${kind} ${name}`;
}

/** Problems keyed by path, first message wins. */
export function problemMap(problems: RuleProblem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of problems) if (!m.has(p.path)) m.set(p.path, p.message);
  return m;
}

/** Problems at or under `prefix` ("rules.default" matches "rules.default.target"). */
export const problemsUnder = (problems: RuleProblem[], prefix: string) =>
  problems.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}.`) || p.path.startsWith(`${prefix}[`));

/** The effective chain of a rule, for the plain-language preset view. */
export const chainOf = (r: Pick<RuleDef, "target" | "fallbacks">) => [r.target, ...(r.fallbacks ?? [])];

/** Dotted path of a change as a sentence fragment: "rules.writing.target" -> "Rule writing · target". */
export function pathLabel(path: string): string {
  const p = path.split(".");
  const head = p[0];
  if (head === "rules" && p.length >= 2) return `Rule ${p[1]}${p.length > 2 ? ` · ${p.slice(2).join(" ")}` : ""}`;
  if (head === "presets" && p.length >= 2) return `Preset ${p[1]}${p.length > 2 ? ` · ${p.slice(2).join(" ")}` : ""}`;
  if (head === "classifier" && p[1] === "routes" && p.length >= 3) return `Classifier route ${p[2]}${p.length > 3 ? ` · ${p[3]}` : ""}`;
  return p.join(" · ");
}

// --- merge (preview) -------------------------------------------------------------------------------
const RULE_KEYS = new Set<string>(RULE_FIELDS);

/**
 * base + overrides -> the effective rules, for the editor's live preview. A mirror of
 * `services/router/app/routing/overrides.py::merge`; the router stays authoritative (it validates and
 * is what routing uses), and `services/router/tests/fixtures/rules_merge_cases.json` is run against both
 * implementations so they can't drift apart.
 */
export function mergeOverrides(base: RulesFile, ov: Overrides): RulesFile {
  const out = structuredClone(base) as RulesFile;
  for (const block of ["defaults", "quota", "summary"] as const) {
    if (ov[block]) Object.assign((out[block] ??= {} as never) as object, ov[block]);
  }
  if (ov.recommender) {
    const { weights, ...rest } = ov.recommender;
    out.recommender = { ...out.recommender, ...rest, weights: { ...out.recommender?.weights, ...weights } };
  }
  if (ov.classifier) {
    const { routes, ...rest } = ov.classifier;
    out.classifier = { ...out.classifier, ...rest };
    for (const [name, o] of Object.entries(routes ?? {})) {
      const hit = out.classifier.routes.find((r) => r.name === name);
      const patch: Json = {};
      for (const k of ["description", "facts"]) if ((o as Json)[k] !== undefined) patch[k] = (o as Json)[k];
      if (hit) Object.assign(hit, patch);
      else out.classifier.routes.push({ name, ...(patch as object) } as never);
    }
  }
  if (ov.rules) {
    let rules = out.rules;
    const added: [string | undefined, RuleDef][] = [];
    for (const [id, o] of Object.entries(ov.rules)) {
      const hit = rules.find((r) => r.id === id);
      const fields = Object.fromEntries(Object.entries(o).filter(([k]) => RULE_KEYS.has(k)));
      if (hit) {
        if (o.disabled) rules = rules.filter((r) => r.id !== id);
        else Object.assign(hit, fields);
      } else if (!o.disabled) added.push([o.before, { id, ...fields } as RuleDef]);
    }
    for (const [before, rule] of added) {
      const ids = rules.map((r) => r.id);
      const at = before && ids.includes(before) ? ids.indexOf(before) : ids.includes("default") ? ids.indexOf("default") : ids.length;
      rules.splice(at, 0, rule);
    }
    out.rules = rules;
  }
  for (const [cmd, rid] of Object.entries(ov.slash ?? {})) {
    if (rid === null) delete out.slash[cmd];
    else out.slash[cmd] = rid;
  }
  for (const [name, o] of Object.entries(ov.presets ?? {})) {
    const cur = (out.presets[name] ??= {});
    if (o.paid) cur.paid = o.paid;
    for (const [rid, ro] of Object.entries(o.rules ?? {})) cur.rules = { ...cur.rules, [rid]: { ...cur.rules?.[rid], ...ro } };
  }
  return out;
}

// --- plain language (Simple mode): no alias names, rule ids or arrows -------------------------------
const PLAIN_ALIAS: Record<string, string> = {
  fast: "a fast free model",
  "smart-free": "a free long-context model",
  explore: "another free model",
  cerebras: "a fast free model",
  "code-free": "a free coding model",
  general: "a general-purpose model",
  grok: "a premium model",
  local: "your local model",
  private: "your local model",
  "local-code": "your local model",
};
const PLAIN_RULE: Record<string, string> = {
  default: "everything else",
  writing: "writing",
  "writing-premium": "high-quality writing",
  "code-light": "quick code questions",
  "code-heavy": "big code tasks",
  research: "research",
  image: "images",
  video: "video",
  audio: "audio",
  bulk: "bulk work",
  private: "private chats",
};

export function plainTarget(t: string): string {
  const [kind, ...rest] = t.split(":");
  const name = rest.join(":");
  if (kind === "model") return PLAIN_ALIAS[name] ?? (name.includes("/") ? "a model you picked" : "another model");
  if (kind === "best") return `the best available model for ${name.replace(/-/g, " ")}`;
  if (kind === "agent") return "an agent";
  return "a media tool";
}

export const plainRuleName = (id: string) => PLAIN_RULE[id] ?? id.replace(/[-_]/g, " ");

/** "Tries a free long-context model, then another free model, then your local model." */
export function plainChain(chain: string[]): string {
  const words = chain.map(plainTarget).filter((w, i, a) => a.indexOf(w) === i);
  if (words.length === 0) return "";
  return `Tries ${words.join(", then ")}.`;
}

export const plainPaid = (p: string | undefined) =>
  p === "never" ? "Never uses paid models." : p === "allowed" ? "May use paid models on its own, within your spending caps." : "Uses paid models only when you pick one.";
