import "server-only";
import { routerGet, type Result } from "./router";
import type { CatalogModel, CatalogResponse, ConnectionRow, ConnectionsResponse, OnboardingResponse } from "../router-types";

export interface ConnectionsData {
  rows: ConnectionRow[];
  modelsByProvider: Record<string, CatalogModel[]>;
  hostprobe: "up" | "down";
}

/** /connections + /catalog in parallel, with models grouped by provider. */
export async function loadConnections(): Promise<Result<ConnectionsData>> {
  const [c, m] = await Promise.all([routerGet<ConnectionsResponse>("/connections"), routerGet<CatalogResponse>("/catalog")]);
  if (!c.ok) return c;
  const modelsByProvider: Record<string, CatalogModel[]> = {};
  // A catalog failure only means no model rows; the provider cards still work.
  for (const model of m.ok ? m.data.models : []) (modelsByProvider[model.provider] ??= []).push(model);
  return { ok: true, data: { rows: c.data.providers, modelsByProvider, hostprobe: c.data.hostprobe } };
}

export const loadOnboarding = () => routerGet<OnboardingResponse>("/onboarding");
