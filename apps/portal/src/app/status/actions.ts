"use server";

import { revalidatePath } from "next/cache";
import { routerSend } from "@/lib/server/router";
import type { ActionResult } from "@/lib/router-types";

/** "Resync models": reconcile LiteLLM now (the router keeps retrying on its own if this fails). */
export async function resyncModels(): Promise<ActionResult<{ ok: boolean }>> {
  const r = await routerSend<{ ok: boolean }>("POST", "/system/resync");
  revalidatePath("/status");
  revalidatePath("/connections");
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };
}
