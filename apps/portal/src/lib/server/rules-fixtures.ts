import "server-only";
import { countChanges, mergeOverrides } from "../rules-model";
import type {
  DryRunResult,
  Overrides,
  RuleDef,
  RuleProblem,
  RulesFile,
  RulesResponse,
  RulesVersion,
  RulesVocab,
} from "../router-types";
import type { Result } from "./router";

/**
 * Rules API stand-in for PORTAL_DATA=fixture (tests, screenshots). The data is a trimmed copy of
 * config/rules.yaml. Validation here only covers the cases the UI tests exercise (unknown alias,
 * number ranges, the private rule); the router's validation is authoritative and is tested in
 * services/router/tests/test_rules_overrides.py. The merge is the same code the editor previews with.
 */

const ok = <T>(data: unknown): Result<T> => ({ ok: true, data: data as T });
const fail = <T>(status: number, error: string, code?: string, extra: object = {}): Result<T> =>
  ({ ok: false, status, error, code, detail: null, ...extra }) as Result<T>;

const BASE: RulesFile = {
  defaults: { temperature: 0.4, autonomy: 1, max_cost_usd: 0.5, daily_cap_usd: 1, max_context_tokens: 8000, max_output_tokens: 4096 },
  rules: [
    { id: "private", when: { private: true }, target: "model:local", fallbacks: [] },
    { id: "image", when: { intent: "image" }, target: "media:image-default", max_cost_usd: 0.1 },
    { id: "video", when: { intent: "video" }, target: "media:grok-imagine-video", autonomy: 0, max_cost_usd: 1 },
    { id: "code-heavy", when: { intent: "code", size: "large" }, target: "agent:claude-code", fallbacks: ["agent:codex", "model:code-free", "model:fast", "model:local-code"], autonomy: 2, temperature: 0.2, job: true },
    { id: "code-light", when: { intent: "code", size: "small" }, target: "model:code-free", fallbacks: ["model:fast", "model:smart-free", "model:local-code"], temperature: 0.2 },
    { id: "research", when: { intent: "research" }, target: "agent:hermes", fallbacks: ["model:smart-free", "model:fast", "model:local"], autonomy: 1, job: true },
    { id: "writing-premium", when: { intent: "writing", quality: "high" }, target: "model:grok", fallbacks: ["model:smart-free", "model:explore", "model:fast"], temperature: 0.7, max_cost_usd: 0.05 },
    { id: "writing", when: { intent: "writing" }, target: "model:smart-free", fallbacks: ["model:explore", "model:fast", "model:local"], temperature: 0.8, autonomy: 0 },
    { id: "bulk", when: { command: "bulk" }, target: "model:code-free", fallbacks: ["model:fast", "model:explore", "model:local"] },
    { id: "default", when: {}, target: "model:fast", fallbacks: ["model:smart-free", "model:explore", "model:local"] },
  ],
  slash: { chat: "default", code: "code-light", research: "research", image: "image", video: "video", private: "private", bulk: "bulk" },
  presets: {
    free: { paid: "never", rules: { "writing-premium": { target: "model:smart-free", fallbacks: ["model:explore", "model:fast", "model:local"] } } },
    balanced: { paid: "manual" },
    best: { paid: "allowed", rules: { default: { target: "best:reasoning", fallbacks: ["model:smart-free", "model:fast", "model:explore", "model:local"] }, writing: { target: "best:reasoning", fallbacks: ["model:smart-free", "model:explore", "model:fast", "model:local"] } } },
  },
  classifier: {
    timeout_s: 1.5,
    breaker_s: 60,
    max_chars: 2000,
    routes: [
      { name: "code_small", description: "Programming help with a small scope: write or fix one function, script, SQL query or regex, explain an error message.", facts: { intent: "code", size: "small" } },
      { name: "code_large", description: "Software work across a whole repository: fix the failing test suite, refactor or migrate many files, implement a feature end to end.", facts: { intent: "code", size: "large" } },
      { name: "research", description: "Research that needs gathering and comparing sources: competitor or market analysis, literature review.", facts: { intent: "research" } },
      { name: "writing", description: "Write, rewrite or polish text for an audience: posts, emails, blog articles, newsletters, cover letters.", facts: { intent: "writing" } },
      { name: "sensitive_health", description: "The user shares their own or a family member's private health details: symptoms, diagnosis, medication, test results.", facts: { sensitive: "health" } },
      { name: "sensitive_finance", description: "The user shares their own private financial details: salary, bank balance, debts, taxes, investments.", facts: { sensitive: "finance" } },
      { name: "general_chat", description: "General questions, explanations, how things work, advice, trivia, brainstorming, small talk.", facts: { intent: "chat" } },
    ],
  },
  recommender: { min_samples: 5, weights: { capability: 0.25, feedback: 0.15, latency: 0.15, success: 0.15, headroom: 0.1, cost: 0.1, privacy: 0.1 } },
  quota: { reroute_at: 0.8, block_at: 1 },
  summary: { start_at: 0.75, keep_last: 6 },
};

const VOCAB: RulesVocab = {
  aliases: ["cerebras", "code-free", "explore", "fast", "general", "local", "local-code", "private", "smart-free"],
  providers: ["cerebras", "gemini", "groq", "mistral", "ollama", "openrouter", "opencode-zen", "xai"],
  capabilities: ["chat", "code", "reasoning", "vision", "long-context", "fast", "small", "image", "video", "audio", "embedding", "moderation"],
  intents: ["audio", "chat", "code", "image", "research", "video", "writing"],
  sensitive: ["finance", "health", "legal", "personal"],
  when_keys: ["command", "intent", "private", "quality", "size"],
  paid_policies: ["never", "manual", "allowed"],
  presets: ["free", "balanced", "best"],
  protected_rules: ["private", "default"],
  limits: { max_rules: 100, max_fallbacks: 10, max_text: 1500 },
};

interface Stored extends RulesVersion {
  overrides: Overrides;
}
interface Store {
  versions: Stored[];
}
const g = globalThis as unknown as { __sbRules?: Store };
const store = (): Store => (g.__sbRules ??= { versions: [] });
const current = (s = store()) => s.versions.at(-1) ?? null;
const view = (v: Stored | null): RulesVersion | null =>
  v && { id: v.id, created_at: v.created_at, source: v.source, note: v.note, rolled_back_to: v.rolled_back_to, changes: v.changes };

const baseTargets = new Set(BASE.rules.flatMap((r) => [r.target, ...(r.fallbacks ?? [])]));

function checkTarget(t: unknown, path: string, out: RuleProblem[]) {
  if (typeof t !== "string" || !/^(model|best|agent|media):[\w.:/@-]{1,200}$/.test(t)) {
    out.push({ path, message: "A target looks like model:fast, model:groq/openai/gpt-oss-20b, best:code, agent:<id> or media:<id>." });
    return;
  }
  if (baseTargets.has(t)) return;
  const [kind, ...r] = t.split(":");
  const rest = r.join(":");
  if (kind === "model" && !rest.includes("/") && !VOCAB.aliases.includes(rest))
    out.push({ path, message: `There is no model alias '${rest}'. Known aliases: ${VOCAB.aliases.join(", ")}.` });
  if (kind === "best" && !VOCAB.capabilities.includes(rest))
    out.push({ path, message: `best:${rest} isn't a capability. Use one of: ${VOCAB.capabilities.join(", ")}.` });
}

export function check(ov: Overrides): RuleProblem[] {
  const out: RuleProblem[] = [];
  for (const [id, o] of Object.entries(ov.rules ?? {})) {
    const p = `rules.${id}`;
    if (o.disabled) {
      if (VOCAB.protected_rules.includes(id)) out.push({ path: p, message: `The \`${id}\` rule can't be removed.` });
      continue;
    }
    if (o.target !== undefined) checkTarget(o.target, `${p}.target`, out);
    (o.fallbacks ?? []).forEach((t, i) => checkTarget(t, `${p}.fallbacks[${i}]`, out));
    if (o.temperature !== undefined && !(o.temperature >= 0 && o.temperature <= 2)) out.push({ path: `${p}.temperature`, message: "Temperature is between 0 and 2." });
    if (o.autonomy !== undefined && !(Number.isInteger(o.autonomy) && o.autonomy >= 0 && o.autonomy <= 3)) out.push({ path: `${p}.autonomy`, message: "Autonomy is a whole number from 0 to 3." });
    if (o.max_cost_usd !== undefined && !(o.max_cost_usd >= 0 && o.max_cost_usd <= 100)) out.push({ path: `${p}.max_cost_usd`, message: "A cost cap is between $0 and $100." });
    if (!BASE.rules.some((r) => r.id === id)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) out.push({ path: p, message: "A rule id uses lowercase letters, digits, - and _ (up to 40)." });
      if (o.target === undefined) out.push({ path: `${p}.target`, message: "A new rule needs a target." });
      if (o.when === undefined) out.push({ path: `${p}.when`, message: "A new rule needs a `when` condition." });
    }
    if (id === "private") {
      const t = o.target?.replace(/^model:/, "");
      if (o.target !== undefined && !(o.target.startsWith("model:") && (["local", "private", "local-code"].includes(t ?? "") || (t ?? "").startsWith("ollama/"))))
        out.push({ path: `${p}.target`, message: "Private chats stay on this machine: use model:local, model:private, model:local-code or model:ollama/<model>." });
      if (o.fallbacks?.length) out.push({ path: `${p}.fallbacks`, message: "Private chats never fall back to another model." });
    }
  }
  for (const [k, v] of Object.entries(ov.defaults ?? {})) {
    if (k === "max_cost_usd" && !(v >= 0 && v <= 100)) out.push({ path: `defaults.${k}`, message: "A cost cap is between $0 and $100." });
  }
  return out;
}

const response = (): RulesResponse => {
  const cur = current();
  const overrides = cur?.overrides ?? {};
  return {
    version: view(cur),
    overrides,
    base: BASE,
    effective: mergeOverrides(BASE, overrides),
    active_preset: "balanced",
    problems: [],
    vocab: VOCAB,
  };
};

function dryRun(text: string, draft: Overrides | undefined): Result<DryRunResult> {
  const ov = draft ?? current()?.overrides ?? {};
  const bad = check(ov);
  if (bad.length) return fail(422, bad[0].message, "rules_invalid", { problems: bad });
  const rules = mergeOverrides(BASE, ov).rules;
  const t = text.toLowerCase();
  const intent = /\b(code|function|bug|stack|regex|sql)\b/.test(t) ? "code" : /\b(post|email|linkedin|blog|write)\b/.test(t) ? "writing" : "chat";
  const route = intent === "code" ? "code_small" : intent === "writing" ? "writing" : "general_chat";
  const rule = rules.find((r) => (r.when?.intent === intent && (intent !== "code" || r.when?.size === "small")) && !r.when?.quality) ?? (rules.find((r) => r.id === "default") as RuleDef);
  const chain = [rule.target, ...(rule.fallbacks ?? [])].filter((x) => x.startsWith("model:"));
  const candidates = chain.slice(0, 3).map((target) => ({ target, label: target.replace("model:", "") }));
  const skipped = chain.slice(3).map((target) => ({ target, label: target.replace("model:", ""), code: "not_connected", reason: "Not connected yet. Add its key in Connections." }));
  return ok<DryRunResult>({
    rule: rule.id,
    matched_by: rule.id === "default" ? "default" : "intent",
    intent,
    size: "small",
    quality: "normal",
    cue: null,
    private: false,
    preset: "balanced",
    classifier: { source: "arch-router", route, ms: 892 },
    sensitive: null,
    candidates,
    skipped,
    chosen: candidates[0] ?? null,
    runner_up: candidates[1]?.label ?? null,
    reasons: [`Matched rule ${rule.id}`, "Free tier with headroom", "Fastest first token (180 ms)"],
    scores: candidates.map((c, i) => ({
      label: c.label,
      score: Math.round((0.82 - i * 0.09) * 1000) / 1000,
      proven: i < 2,
      parts: { capability: 0.9 - i * 0.05, feedback: 0.6, latency: 0.8 - i * 0.1, success: 0.95, headroom: 0.7 - i * 0.1, cost: 1, privacy: i === 0 ? 0.5 : 1 },
    })),
  });
}

function diff(a: Overrides, b: Overrides) {
  const flat = (v: unknown, p = ""): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
      ? Object.entries(v).reduce((o, [k, x]) => ({ ...o, ...flat(x, p ? `${p}.${k}` : k) }), {})
      : p ? { [p]: v } : {};
  const fa = flat(a), fb = flat(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort().flatMap((path) =>
    path in fa && path in fb
      ? JSON.stringify(fa[path]) === JSON.stringify(fb[path]) ? [] : [{ path, kind: "changed", before: fa[path], after: fb[path] }]
      : path in fb ? [{ path, kind: "added", before: null, after: fb[path] }] : [{ path, kind: "removed", before: fa[path], after: null }],
  );
}

export function handle<T>(method: string, path: string, body: unknown): Result<T> {
  const s = store();
  const url = new URL(path, "http://fixture");
  const p = url.pathname;
  const b = (body ?? {}) as { overrides?: Overrides; note?: string | null; base_version?: number | null; text?: string; draft?: Overrides };
  if (method === "GET" && p === "/rules") return ok(response());
  if (method === "POST" && p === "/rules/validate") {
    const problems = check(b.overrides ?? {});
    return ok({ ok: problems.length === 0, problems, rules: BASE.rules.length });
  }
  if (method === "PUT" && p === "/rules/overrides") {
    const ov = b.overrides ?? {};
    const problems = check(ov);
    if (problems.length) return fail(422, problems[0].message + (problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""), "rules_invalid", { problems });
    const cur = current(s);
    if ((cur?.id ?? null) !== (b.base_version ?? null)) return fail(409, "The rules were changed somewhere else. Reload them and apply your edit again.", "rules_stale");
    if (JSON.stringify(cur?.overrides ?? {}) === JSON.stringify(ov)) return ok({ version: view(cur), created: false });
    const v: Stored = { id: (cur?.id ?? 0) + 1, created_at: new Date().toISOString(), source: "edit", note: b.note?.trim() || null, rolled_back_to: null, changes: countChanges(ov), overrides: ov };
    s.versions.push(v);
    return ok({ version: view(v), created: true });
  }
  if (method === "GET" && p === "/rules/versions") {
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const before = Number(url.searchParams.get("before") ?? Infinity);
    const all = [...s.versions].reverse().filter((v) => v.id < before);
    const page = all.slice(0, limit);
    return ok({ versions: page.map(view), next_before: all.length > limit ? page.at(-1)!.id : null });
  }
  const m = /^\/rules\/versions\/(\d+)(\/diff|\/rollback)?$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    const v = s.versions.find((x) => x.id === id);
    if (!v) return fail(404, "That version doesn't exist.", "not_found");
    if (method === "GET" && !m[2]) return ok({ ...view(v), overrides: v.overrides });
    if (method === "GET" && m[2] === "/diff") {
      const against = url.searchParams.get("against") ?? "previous";
      const other = against === "base" ? {} : against === "current" ? (current(s)?.overrides ?? {}) : against === "previous" ? (s.versions.find((x) => x.id === id - 1)?.overrides ?? {}) : (s.versions.find((x) => x.id === Number(against))?.overrides ?? {});
      return ok({ version: id, against, changes: diff(other, v.overrides) });
    }
    if (method === "POST" && m[2] === "/rollback") {
      const cur = current(s);
      if (JSON.stringify(cur?.overrides ?? {}) === JSON.stringify(v.overrides)) return ok({ version: view(cur), created: false });
      const n: Stored = { id: (cur?.id ?? 0) + 1, created_at: new Date().toISOString(), source: "rollback", note: `Rolled back to version ${id}`, rolled_back_to: id, changes: v.changes, overrides: v.overrides };
      s.versions.push(n);
      return ok({ version: view(n), created: true });
    }
  }
  if (method === "POST" && p === "/route/dry-run") return dryRun(String(b.text ?? ""), b.draft) as Result<T>;
  return fail(404, `fixture: no ${method} ${p}`);
}
