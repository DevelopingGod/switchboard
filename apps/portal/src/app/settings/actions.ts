"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult, LocalProfileView, SettingsView, OverflowSettings } from "@/lib/router-types";
import type { SubscriptionItem } from "@/lib/metrics-types";

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

/** Settings → Subscriptions (M6): plans you pay for, used only for net savings on Metrics. */
export async function saveSubscriptions(items: SubscriptionItem[]): Promise<ActionResult<{ items: SubscriptionItem[] }>> {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!Array.isArray(items) || items.length > 20) return { ok: false, error: "Up to 20 subscriptions." };
  for (const s of items) {
    const okFee = typeof s.monthly_usd === "number" && Number.isFinite(s.monthly_usd) && s.monthly_usd >= 0 && s.monthly_usd <= 10_000;
    if (!s.name?.trim() || s.name.length > 60 || !okFee || !day.test(s.start) || (s.end && !day.test(s.end)) || (s.end && s.end < s.start)) {
      return { ok: false, error: "Each plan needs a name, a fee from 0 to 10,000 and a start date (the end date, if any, after it)." };
    }
  }
  const r = await routerSend<{ items: SubscriptionItem[] }>("PUT", "/settings/subscriptions", {
    items: items.map((s) => ({ name: s.name.trim(), monthly_usd: s.monthly_usd, start: s.start, end: s.end || null })),
  });
  revalidatePath("/settings");
  revalidatePath("/metrics");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}


// --- M6.5: accounts (ADR 0013) and paid overflow (ADR 0015) -------------------------------------------
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,30}$/;
const CLI = /^[a-z][a-z0-9-]{0,15}$/;
const done = <T>(r: { ok: true; data: T } | { ok: false; error: string; code?: string; detail?: string | null }): ActionResult<T> =>
  r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };

export async function addAccount(cli: string, name: string, label: string): Promise<ActionResult<{ login_command: string | null; home: string | null }>> {
  if (!CLI.test(cli)) return { ok: false, error: "Pick a CLI." };
  if (!ACCOUNT.test(name) || name === "default") return { ok: false, error: "Use a short name: lowercase letters, digits and dashes." };
  const r = await routerSend<{ login_command: string | null; home: string | null }>("POST", "/accounts", { cli, name, label: label.trim().slice(0, 80) || null }, 30_000);
  revalidatePath("/settings");
  return done(r);
}

export async function removeAccount(cli: string, name: string): Promise<ActionResult<{ removed: boolean }>> {
  if (!CLI.test(cli) || !ACCOUNT.test(name)) return { ok: false, error: "Invalid account." };
  const r = await routerSend<{ removed: boolean }>("DELETE", `/accounts/${cli}/${name}`);
  revalidatePath("/settings");
  return done(r);
}

export async function checkAccount(cli: string, name: string): Promise<ActionResult<{ logged_in: boolean | null }>> {
  if (!CLI.test(cli) || !ACCOUNT.test(name)) return { ok: false, error: "Invalid account." };
  const r = await routerSend<{ logged_in: boolean | null }>("POST", `/accounts/${cli}/${name}/check`, undefined, 30_000);
  revalidatePath("/settings");
  return done(r);
}

export async function saveOverflow(v: { enabled: boolean; monthly_usd: number | null; model: string | null }): Promise<ActionResult<OverflowSettings>> {
  if (v.monthly_usd != null && !(Number.isFinite(v.monthly_usd) && v.monthly_usd > 0 && v.monthly_usd <= 10_000)) return { ok: false, error: "Enter a monthly budget between $0.01 and $10,000." };
  if (v.model != null && (v.model.length > 200 || !/^[\w./:-]+$/.test(v.model))) return { ok: false, error: "Pick a model." };
  const r = await routerSend<OverflowSettings>("PUT", "/settings/overflow", { enabled: !!v.enabled, monthly_usd: v.monthly_usd, model: v.model });
  revalidatePath("/settings");
  return done(r);
}
