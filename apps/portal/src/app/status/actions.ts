"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult } from "@/lib/router-types";

/** "Pull models" (M3a): the local-model profile's missing Ollama models, in the background. */
export async function pullModels(): Promise<ActionResult<{ started: boolean }>> {
  const r = await routerSend<{ started: boolean }>("POST", "/system/models/pull");
  revalidatePath("/status");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}

/** "Catch up now" (M6.5): recompute every waiting Metrics rollup bucket at once. */
export async function runRollups(): Promise<ActionResult<{ recomputed: number }>> {
  const r = await routerSend<{ recomputed: number }>("POST", "/system/rollups/run", undefined, 60_000);
  revalidatePath("/status");
  revalidatePath("/metrics");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}

/** "Resync models": reconcile LiteLLM now (the router keeps retrying on its own if this fails). */
export async function resyncModels(): Promise<ActionResult<{ ok: boolean }>> {
  const r = await routerSend<{ ok: boolean }>("POST", "/system/resync");
  revalidatePath("/status");
  revalidatePath("/connections");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}
