/** Target picker helpers (lazy picker chunk; unit-tested in chat-format.test.ts). */
import type { TargetProvider, TargetsResponse } from "./router-types";
import { isFreeModel, recommend, type Badge } from "./recommend";

/** Badges per model id, computed per provider like the Connections cards (SPEC §6.4 UI). */
export function badgesFor(p: TargetProvider): Map<string, Badge[]> {
  const out = new Map<string, Badge[]>();
  for (const pick of recommend(p.models).picks) out.set(pick.model.model_id, pick.badges);
  for (const m of p.models) if (isFreeModel(m) && !out.has(m.model_id)) out.set(m.model_id, ["free"]);
  return out;
}

/** Targets usable with the Private switch on (local only). */
export function privateTargets(t: TargetsResponse): Set<string> {
  const s = new Set<string>(["auto"]);
  for (const a of t.aliases) if (a.local) s.add(a.target);
  for (const p of t.providers) if (p.local) for (const m of p.models) s.add(m.target);
  return s;
}
