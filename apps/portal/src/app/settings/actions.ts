"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult, LocalProfileView, SettingsView } from "@/lib/router-types";

export interface SettingsPatch {
  max_cost_usd?: number | null;
  daily_cap_usd?: number | null;
  private_by_default?: boolean | null;
  explore?: boolean | null;
  auto_private?: boolean | null;
  /** M4b jobs: hours a job may wait for your approval (0 = never), and worktrees kept per project. */
  approval_expiry_h?: number | null;
  keep_worktrees_per_project?: number | null;
}

const cap = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);

/** Caps and the private default (router system_meta "settings"); null = back to rules.yaml. */
export async function saveSettings(patch: SettingsPatch): Promise<ActionResult<SettingsView>> {
  const clean: Record<string, unknown> = {};
  for (const k of ["max_cost_usd", "daily_cap_usd"] as const) {
    if (patch[k] === undefined) continue;
    if (!cap(patch[k])) return { ok: false, error: "Enter an amount between 0 and 100." };
    clean[k] = patch[k];
  }
  for (const k of ["private_by_default", "explore", "auto_private"] as const) {
    if (patch[k] === undefined) continue;
    if (patch[k] !== null && typeof patch[k] !== "boolean") return { ok: false, error: "Invalid value." };
    clean[k] = patch[k];
  }
  if (patch.approval_expiry_h !== undefined) {
    const v = patch.approval_expiry_h;
    if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 720)) return { ok: false, error: "Enter between 0 and 720 hours (0 = never)." };
    clean.approval_expiry_h = v;
  }
  if (patch.keep_worktrees_per_project !== undefined) {
    const v = patch.keep_worktrees_per_project;
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100)) return { ok: false, error: "Enter a whole number from 0 to 100." };
    clean.keep_worktrees_per_project = v;
  }
  const r = await routerSend<SettingsView>("PUT", "/settings", clean);
  revalidatePath("/settings");
  revalidatePath("/settings/projects");
  revalidatePath("/chat");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}

/** Settings → Data → Clear chats. The phrase is required by the router too. */
export async function clearChats(word: string): Promise<ActionResult<{ deleted: number }>> {
  if (String(word).trim().toLowerCase() !== "delete") return { ok: false, error: "Type delete to confirm." };
  const r = await routerSend<{ deleted: number }>("DELETE", "/chat/threads", { confirm: "delete all chats" });
  revalidatePath("/chat");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

const PROFILE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Settings → Local models (M3a): pick a profile, or null to go back to the detected one. */
export async function setLocalProfile(name: string | null): Promise<ActionResult<LocalProfileView>> {
  if (name !== null && !PROFILE.test(name)) return { ok: false, error: "Invalid value." };
  const r = await routerSend<LocalProfileView>("PUT", "/system/local-profile", { profile: name });
  revalidatePath("/settings");
  revalidatePath("/status");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}
