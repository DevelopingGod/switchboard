"use server";

import { routerGetAdmin, routerSend } from "@/lib/server/router";
import type { ActionResult, ChatThread, TargetsResponse } from "@/lib/router-types";

// Server actions are reachable by direct POST, so every input is validated again here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string): ActionResult<never> => ({ ok: false, error });

export async function renameThread(id: string, title: string): Promise<ActionResult<ChatThread>> {
  const clean = String(title ?? "").trim().slice(0, 80);
  if (!UUID.test(id) || !clean) return bad("Give the chat a name.");
  const r = await routerSend<ChatThread>("PATCH", `/chat/threads/${id}`, { title: clean });
  return r.ok ? { ok: true, data: r.data } : bad(r.error);
}

export async function pinThread(id: string, pinned: boolean): Promise<ActionResult<ChatThread>> {
  if (!UUID.test(id) || typeof pinned !== "boolean") return bad("Unknown chat.");
  const r = await routerSend<ChatThread>("PATCH", `/chat/threads/${id}`, { pinned });
  return r.ok ? { ok: true, data: r.data } : bad(r.error);
}

export async function deleteThread(id: string): Promise<ActionResult> {
  if (!UUID.test(id)) return bad("Unknown chat.");
  const r = await routerSend("DELETE", `/chat/threads/${id}`);
  return r.ok ? { ok: true, data: null } : bad(r.error);
}

export async function stopReply(requestId: number): Promise<ActionResult> {
  if (!Number.isInteger(requestId) || requestId <= 0) return bad("Unknown request.");
  const r = await routerSend("POST", `/chat/requests/${requestId}/stop`);
  return r.ok ? { ok: true, data: null } : bad(r.error);
}

export async function sendFeedback(messageId: number, value: "up" | "down" | null): Promise<ActionResult> {
  if (!Number.isInteger(messageId) || messageId <= 0) return bad("Unknown reply.");
  if (value !== "up" && value !== "down" && value !== null) return bad("Invalid feedback.");
  const r = await routerSend("POST", `/chat/messages/${messageId}/feedback`, { value });
  return r.ok ? { ok: true, data: null } : bad(r.error);
}

/** Picker data, fetched when the target picker first opens (keeps it out of the page payload). */
export async function loadTargets(): Promise<ActionResult<TargetsResponse>> {
  const r = await routerGetAdmin<TargetsResponse>("/chat/targets");
  return r.ok ? { ok: true, data: r.data } : bad(r.error);
}
