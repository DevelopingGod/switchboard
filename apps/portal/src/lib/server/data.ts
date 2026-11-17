import "server-only";
import { connection } from "next/server";
import { routerGet, routerGetAdmin, type Result } from "./router";
import type {
  CatalogModel,
  CatalogResponse,
  ChatThread,
  ConnectionRow,
  ConnectionsResponse,
  OnboardingResponse,
  ThreadResponse,
} from "../router-types";

export interface ConnectionsData {
  rows: ConnectionRow[];
  modelsByProvider: Record<string, CatalogModel[]>;
  hostprobe: "up" | "down";
}

/** /connections + /catalog in parallel, with models grouped by provider. */
export async function loadConnections(): Promise<Result<ConnectionsData>> {
  await connection(); // router data is live: never prerender it at build time (also true for fixtures)
  const [c, m] = await Promise.all([routerGet<ConnectionsResponse>("/connections"), routerGet<CatalogResponse>("/catalog")]);
  if (!c.ok) return c;
  const modelsByProvider: Record<string, CatalogModel[]> = {};
  // A catalog failure only means no model rows; the provider cards still work.
  for (const model of m.ok ? m.data.models : []) (modelsByProvider[model.provider] ??= []).push(model);
  return { ok: true, data: { rows: c.data.providers, modelsByProvider, hostprobe: c.data.hostprobe } };
}

export interface ChatData {
  threads: ChatThread[];
  current: ThreadResponse | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thread list + the selected thread (if `id` is a valid thread id). */
export async function loadChat(id: string | undefined): Promise<Result<ChatData>> {
  await connection();
  const wanted = id && UUID.test(id) ? id : null;
  const [list, cur] = await Promise.all([
    routerGetAdmin<{ threads: ChatThread[] }>("/chat/threads"),
    wanted ? routerGetAdmin<ThreadResponse>(`/chat/threads/${wanted}`) : Promise.resolve(null),
  ]);
  if (!list.ok) return list;
  return { ok: true, data: { threads: list.data.threads, current: cur && cur.ok ? cur.data : null } };
}

export async function loadOnboarding(): Promise<Result<OnboardingResponse>> {
  await connection();
  return routerGet<OnboardingResponse>("/onboarding");
}
