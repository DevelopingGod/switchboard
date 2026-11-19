"use server";

import { routerGet, routerSend } from "@/lib/server/router";
import type {
  ActionResult,
  DryRunResult,
  Overrides,
  RulesDiffChange,
  RulesResponse,
  RulesVersion,
  RulesVersionsResponse,
} from "@/lib/router-types";

// Server actions are reachable by direct POST, so every input is checked again here. The router
// validates the rules themselves (ADR 0004); this only keeps the shape and size sane before it asks.
const bad = <T = never>(error: string): ActionResult<T> => ({ ok: false, error });
const MAX_JSON = 64_000;

const isDoc = (v: unknown): v is Overrides => !!v && typeof v === "object" && !Array.isArray(v) && JSON.stringify(v).length <= MAX_JSON;
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9;

const fromResult = <T>(r: Awaited<ReturnType<typeof routerGet<T>>>): ActionResult<T> =>
  r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail, problems: r.problems };

export async function reloadRules(): Promise<ActionResult<RulesResponse>> {
  return fromResult(await routerGet<RulesResponse>("/rules"));
}

export async function validateRules(overrides: Overrides): Promise<ActionResult<{ ok: boolean; problems: { path: string; message: string }[] }>> {
  if (!isDoc(overrides)) return bad("Those changes are too large.");
  return fromResult(await routerSend("POST", "/rules/validate", { overrides }, 15_000));
}

export async function saveRules(
  overrides: Overrides,
  note: string,
  baseVersion: number | null,
): Promise<ActionResult<{ version: RulesVersion | null; created: boolean }>> {
  if (!isDoc(overrides)) return bad("Those changes are too large.");
  if (baseVersion !== null && !isId(baseVersion)) return bad("Unknown version.");
  return fromResult(await routerSend("PUT", "/rules/overrides", { overrides, note: String(note ?? "").slice(0, 200), base_version: baseVersion }));
}

export async function rollbackRules(id: number): Promise<ActionResult<{ version: RulesVersion | null; created: boolean }>> {
  if (!isId(id)) return bad("Unknown version.");
  return fromResult(await routerSend("POST", `/rules/versions/${id}/rollback`));
}

export async function loadVersions(before: number | null): Promise<ActionResult<RulesVersionsResponse>> {
  if (before !== null && !isId(before)) return bad("Unknown version.");
  return fromResult(await routerGet<RulesVersionsResponse>(`/rules/versions?limit=20${before ? `&before=${before}` : ""}`));
}

export async function loadDiff(id: number, against: "previous" | "base"): Promise<ActionResult<{ changes: RulesDiffChange[] }>> {
  if (!isId(id) || (against !== "previous" && against !== "base")) return bad("Unknown version.");
  return fromResult(await routerGet<{ changes: RulesDiffChange[] }>(`/rules/versions/${id}/diff?against=${against}`));
}

export async function dryRun(text: string, priv: boolean, draft: Overrides | null): Promise<ActionResult<DryRunResult>> {
  const t = String(text ?? "").trim();
  if (!t) return bad("Type a message to test.");
  if (draft !== null && !isDoc(draft)) return bad("Those changes are too large.");
  return fromResult(
    await routerSend<DryRunResult>("POST", "/route/dry-run", { text: t.slice(0, 4000), private: priv === true, ...(draft ? { draft } : {}) }, 30_000),
  );
}
