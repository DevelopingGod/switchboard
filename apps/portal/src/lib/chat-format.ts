/** Small pure helpers for chat display (unit-tested in chat-format.test.ts). */
import type { RouteInfo, TargetsResponse } from "./router-types";

/** "$0.0012" / "< $0.0001" for tiny amounts. */
export function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n === 0) return "$0";
  if (n < 0.0001) return "< $0.0001";
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function ms(n: number | null | undefined): string {
  if (n == null) return "—";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

/** Label for the chip: the alias name when a rule targeted one, otherwise the model label. */
export function chipTarget(r: RouteInfo): string {
  return r.label ?? r.target ?? "—";
}


/** Display name for a target string, using the picker data when it is loaded. */
export function targetName(target: string, t: TargetsResponse | null): string | null {
  if (target === "auto") return null;
  const a = t?.aliases.find((x) => x.target === target);
  if (a) return a.alias;
  for (const p of t?.providers ?? []) {
    const m = p.models.find((x) => x.target === target);
    if (m) return m.display_name ?? m.model_id;
  }
  return target.replace(/^model:/, "");
}

/** One plain sentence for Simple mode's "Why this?": no rule names, scores or alias words. */
export function plainReason(r: RouteInfo): "private" | "sensitive" | "manual" | "slash" | "busy" | "code" | "writing" | "research" | "quick" | "everyday" {
  if (r.sensitive || r.matched_by === "auto_private" || r.matched_by === "secret") return "sensitive";
  if (r.matched_by === "private" || r.private) return "private";
  if (r.matched_by === "manual") return "manual";
  if (r.matched_by === "slash") return "slash";
  if (r.skipped.some((s) => /cool|rate|quota|limit|busy|timeout/i.test(`${s.code} ${s.reason}`))) return "busy";
  if (r.intent === "code" || r.intent === "writing" || r.intent === "research") return r.intent;
  return r.cost_usd === 0 || r.free_tier ? "quick" : "everyday";
}
