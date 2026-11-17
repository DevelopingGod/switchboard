"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult, OnboardingPatch, OnboardingState } from "@/lib/router-types";

const STEPS = new Set(["welcome", "goals", "connect", "preset", "finish"]);
const PRESETS = new Set(["free", "balanced", "best"]);

/** Saves wizard progress in the router so it resumes on any device. Partial updates only. */
export async function saveOnboarding(patch: OnboardingPatch): Promise<ActionResult<OnboardingState>> {
  const clean: Record<string, unknown> = {};
  if (patch.step !== undefined) {
    if (!STEPS.has(patch.step)) return { ok: false, error: "Unknown step." };
    clean.step = patch.step;
  }
  if (patch.name !== undefined) clean.name = String(patch.name).slice(0, 60);
  if (patch.goals !== undefined) clean.goals = patch.goals.filter((g) => /^[\w-]{1,32}$/.test(g)).slice(0, 12);
  if (patch.preset !== undefined && patch.preset !== null) {
    if (!PRESETS.has(patch.preset)) return { ok: false, error: "Unknown preset." };
    clean.preset = patch.preset;
  }
  if (typeof patch.skipped === "boolean") clean.skipped = patch.skipped;
  if (typeof patch.completed === "boolean") clean.completed = patch.completed;
  const r = await routerSend<{ state: OnboardingState }>("PUT", "/onboarding", clean);
  revalidatePath("/", "layout");
  return r.ok ? { ok: true, data: r.data.state } : { ok: false, error: r.error };
}
