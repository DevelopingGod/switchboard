"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult, InstallJob, InstallPlan } from "@/lib/router-types";

/**
 * Server actions for the Connections screen. They run on the portal server, attach the admin token
 * there and return plain results; the browser never sees the token or the router URL.
 * Everything arriving from the client is validated again here: actions are reachable by direct POST.
 */

const ID = /^[\w-]{1,64}$/;
const bad = (error: string): ActionResult<never> => ({ ok: false, error });

async function run<T>(p: ReturnType<typeof routerSend<T>>, refresh = true): Promise<ActionResult<T>> {
  const r = await p;
  if (refresh) revalidatePath("/connections");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
}

export async function saveKey(provider: string, apiKey: string): Promise<ActionResult<{ key_last4: string }>> {
  if (!ID.test(provider)) return bad("Unknown provider.");
  if (typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.length > 512) return bad("That does not look like an API key.");
  return run(routerSend<{ key_last4: string }>("PUT", `/connections/${provider}/key`, { api_key: apiKey.trim() }, 90_000));
}

export async function removeKey(provider: string): Promise<ActionResult<{ removed: boolean }>> {
  if (!ID.test(provider)) return bad("Unknown provider.");
  return run(routerSend<{ removed: boolean }>("DELETE", `/connections/${provider}/key`));
}

export async function testConnection(provider: string): Promise<ActionResult<{ ok: boolean; error?: string }>> {
  if (!ID.test(provider)) return bad("Unknown provider.");
  return run(routerSend<{ ok: boolean; error?: string }>("POST", `/connections/${provider}/test`));
}

export interface ModelTestResult {
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
}

export async function testModel(provider: string, modelId: string): Promise<ActionResult<ModelTestResult>> {
  if (!ID.test(provider) || typeof modelId !== "string" || !modelId || modelId.length > 200) return bad("Unknown model.");
  return run(routerSend<ModelTestResult>("POST", "/models/test", { provider, model_id: modelId }, 90_000));
}

export interface CliCheck {
  status: string;
  bin_path: string | null;
  bin_dir: string | null;
  on_user_path: boolean | null;
}

/** "Check again": a fresh probe through the router. Returns provider id → status and PATH facts. */
export async function cliCheck(): Promise<ActionResult<Record<string, CliCheck>>> {
  const r = await routerSend<{ clis: Record<string, Partial<CliCheck> & { status: string }> }>("POST", "/connections/cli/refresh");
  revalidatePath("/connections");
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    data: Object.fromEntries(
      Object.entries(r.data.clis).map(([id, c]) => [
        id,
        { status: c.status, bin_path: c.bin_path ?? null, bin_dir: c.bin_dir ?? null, on_user_path: c.on_user_path ?? null },
      ]),
    ),
  };
}

export async function cliInstallPlan(provider: string): Promise<ActionResult<InstallPlan>> {
  if (!ID.test(provider)) return bad("Unknown provider.");
  return run(routerSend<InstallPlan>("POST", `/connections/cli/${provider}/install-plan`, undefined, 60_000), false);
}

export async function cliInstallRun(provider: string, planId: string): Promise<ActionResult<InstallJob>> {
  if (!ID.test(provider) || typeof planId !== "string" || !ID.test(planId)) return bad("That plan is not valid.");
  return run(routerSend<InstallJob>("POST", `/connections/cli/${provider}/install`, { plan_id: planId }), false);
}

export async function cliInstallCancel(jobId: string): Promise<ActionResult<null>> {
  if (typeof jobId !== "string" || !ID.test(jobId)) return bad("Unknown job.");
  const r = await routerSend("POST", `/connections/cli/jobs/${jobId}/cancel`);
  return r.ok ? { ok: true, data: null } : { ok: false, error: r.error };
}
