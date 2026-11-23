"use server";

import { revalidatePath } from "next/cache";
import { routerGetAdmin, routerSend, type Result } from "@/lib/server/router";
import type { ActionResult } from "@/lib/router-types";
import type { PackJob, PackPlan, PackVerify } from "@/lib/packs-types";

/**
 * Workflow pack actions (M4.5a): plan → confirm → install, roll back, remove, check. They run on the portal server
 * with the admin token; inputs are checked here and again by the router and hostprobe.
 */

const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const JOB_ID = /^[\w-]{1,64}$/;
const bad = (error: string): ActionResult<never> => ({ ok: false, error });
const res = <T>(r: Result<T>, refresh = false): ActionResult<T> => {
  if (refresh) {
    revalidatePath("/connections");
    revalidatePath("/settings/projects");
  }
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
};

export async function packInstallPlan(id: string): Promise<ActionResult<PackPlan>> {
  if (!PACK_ID.test(id)) return bad("Unknown pack.");
  return res(await routerSend<PackPlan>("POST", `/packs/${id}/install-plan`, undefined, 60_000));
}

export async function packInstallRun(id: string, planId: string, acceptUnverified = false): Promise<ActionResult<PackJob>> {
  if (!PACK_ID.test(id) || typeof planId !== "string" || !JOB_ID.test(planId)) return bad("That plan is not valid.");
  return res(await routerSend<PackJob>("POST", `/packs/${id}/install`, { plan_id: planId, accept_unverified: acceptUnverified === true }));
}

export async function packRollback(id: string): Promise<ActionResult<{ current: string | null }>> {
  if (!PACK_ID.test(id)) return bad("Unknown pack.");
  return res(await routerSend<{ current: string | null }>("POST", `/packs/${id}/rollback`, undefined, 120_000), true);
}

export async function packUninstall(id: string): Promise<ActionResult<{ removed: boolean }>> {
  if (!PACK_ID.test(id)) return bad("Unknown pack.");
  return res(await routerSend<{ removed: boolean }>("POST", `/packs/${id}/uninstall`, undefined, 120_000), true);
}

export async function packCheck(id: string): Promise<ActionResult<{ current: string; verify: PackVerify }>> {
  if (!PACK_ID.test(id)) return bad("Unknown pack.");
  return res(await routerGetAdmin<{ current: string; verify: PackVerify }>(`/packs/${id}/check`));
}

export async function packsRefresh(): Promise<void> {
  revalidatePath("/connections");
  revalidatePath("/settings/projects");
}
