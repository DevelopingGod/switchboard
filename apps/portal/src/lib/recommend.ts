import type { CatalogModel } from "./router-types";

export type Badge = "code" | "fastest" | "context" | "free" | "paid";

export interface Recommended {
  model: CatalogModel;
  badges: Badge[];
}

/** Tags that mean "not a chat model", so they never get a recommendation badge. */
const NOT_CHAT = new Set(["embedding", "moderation", "audio", "image", "video"]);

/**
 * Providers that price each model separately, so "free" is per model (OpenRouter `:free`, Zen zero
 * cost). Only their free models are recommended (badged); a paid one that is still shown anywhere is
 * labelled Paid, because automatic routing never uses it (provider-fixes, M1.5).
 */
export const PER_MODEL_PRICED = new Set(["openrouter", "opencode-zen"]);

export const isFreeModel = (m: CatalogModel) => m.free || (m.provider === "openrouter" && m.model_id.endsWith(":free"));

const isChat = (m: CatalogModel) =>
  m.status === "available" && m.tags.includes("chat") && !m.tags.some((t) => NOT_CHAT.has(t));

const byContextDesc = (a: CatalogModel, b: CatalogModel) =>
  (b.context ?? 0) - (a.context ?? 0) || a.model_id.localeCompare(b.model_id);

/** Passed a recent test: measured speed beats the "fast" tag when we have it. */
const measured = (m: CatalogModel) => (m.test && m.test.last_ok && m.test.p50_ms != null ? m.test.p50_ms : null);

/**
 * Badges from catalog tags (SPEC §6.4, M1 scope). Scores and learning are M3; this is a pure
 * function of the catalog rows so it can be unit-tested.
 *  - Best for code: tagged `code`, preferring `reasoning`, then the larger context.
 *  - Fastest: lowest measured p50 from a passed test, otherwise tagged `fast` (larger context first).
 *  - Largest context: biggest context window among chat models.
 *  - Free: the model's `free` flag, added to whichever models were picked.
 * Untagged models never get a badge; they are only counted.
 * For per-model-priced providers (OpenRouter, Zen) only free models are candidates.
 */
export function recommend(models: CatalogModel[], limit = 3): { picks: Recommended[]; untagged: number } {
  const chat = models.filter((m) => isChat(m) && (!PER_MODEL_PRICED.has(m.provider) || isFreeModel(m)));
  const untagged = models.filter((m) => m.status === "available" && m.tags.length === 0).length;

  const code = chat
    .filter((m) => m.tags.includes("code"))
    .sort((a, b) => Number(b.tags.includes("reasoning")) - Number(a.tags.includes("reasoning")) || byContextDesc(a, b))[0];

  const timed = chat.filter((m) => measured(m) !== null).sort((a, b) => measured(a)! - measured(b)!);
  const fastest = timed[0] ?? chat.filter((m) => m.tags.includes("fast")).sort(byContextDesc)[0];

  const context = chat.filter((m) => m.context).sort(byContextDesc)[0];

  const order: [Badge, CatalogModel | undefined][] = [
    ["code", code],
    ["fastest", fastest],
    ["context", context],
  ];
  const picked = new Map<string, Recommended>();
  for (const [badge, model] of order) {
    if (!model) continue;
    const key = `${model.provider}/${model.model_id}`;
    const entry = picked.get(key) ?? { model, badges: [] };
    entry.badges.push(badge);
    picked.set(key, entry);
  }
  const picks = [...picked.values()].slice(0, limit);
  for (const p of picks) {
    if (isFreeModel(p.model)) p.badges.push("free");
    else if (PER_MODEL_PRICED.has(p.model.provider)) p.badges.push("paid");
  }
  return { picks, untagged };
}

/** "1M", "200k", "8k" for a context window. */
export function formatContext(tokens: number | null): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
