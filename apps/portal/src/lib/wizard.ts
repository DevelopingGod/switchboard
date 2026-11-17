import type { OnboardingResponse, OnboardingStep } from "./router-types";

export const STEPS: readonly OnboardingStep[] = ["welcome", "goals", "connect", "preset", "finish"];

/** Display order of the wizard's goals. The goal -> provider mapping itself lives in config/providers.yaml. */
export const GOAL_ORDER = ["chat", "writing", "code", "research", "images", "video", "private"] as const;

/** Providers the chosen goals need, each with the goals that need it. */
export function neededProviders(goals: string[], map: OnboardingResponse["goals"]): { provider: string; paid: boolean; for: string[] }[] {
  const out = new Map<string, { provider: string; paid: boolean; for: string[] }>();
  for (const g of GOAL_ORDER.filter((x) => goals.includes(x))) {
    for (const p of map[g] ?? []) {
      const e = out.get(p.provider) ?? { provider: p.provider, paid: p.paid, for: [] };
      e.for.push(g);
      out.set(p.provider, e);
    }
  }
  return [...out.values()];
}

