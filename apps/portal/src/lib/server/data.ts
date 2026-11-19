import "server-only";
import { connection } from "next/server";
import { routerGet, routerGetAdmin, type Result } from "./router";
import type {
  CatalogModel,
  CatalogResponse,
  ComponentsResponse,
  ConnectionRow,
  ConnectionsResponse,
  SettingsView,
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
  current: ThreadResponse | null;
  /** Settings → Privacy (false when the setting can't be read). */
  privateDefault: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The selected thread (if `id` is a valid thread id). The thread list lives in the sidebar (M3b). */
export async function loadChat(id: string | undefined): Promise<Result<ChatData>> {
  await connection();
  const wanted = id && UUID.test(id) ? id : null;
  const [cur, settings] = await Promise.all([
    wanted ? routerGetAdmin<ThreadResponse>(`/chat/threads/${wanted}`) : Promise.resolve(null),
    routerGet<SettingsView>("/settings"),
  ]);
  if (!settings.ok) return settings; // the router being down is the one thing the page shows
  return {
    ok: true,
    data: {
      current: cur && cur.ok ? cur.data : null,
      privateDefault: settings.ok && settings.data.private_by_default,
    },
  };
}

export async function loadOnboarding(): Promise<Result<OnboardingResponse>> {
  await connection();
  return routerGet<OnboardingResponse>("/onboarding");
}

/** Status view. When the router itself is down, that is the one thing to fix (start Docker). */
export async function loadComponents(): Promise<ComponentsResponse> {
  await connection();
  const r = await routerGet<ComponentsResponse>("/system/components");
  if (r.ok) return r.data;
  return { status: "down", components: [{ id: "router", status: "down", fix: "start_docker", detail: r.error, code: r.code ?? "router_down" }] };
}

/** Settings page data. */
export async function loadSettings(): Promise<Result<SettingsView>> {
  await connection();
  return routerGet<SettingsView>("/settings");
}
