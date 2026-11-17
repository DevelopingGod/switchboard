import "server-only";
import * as fixtures from "./fixtures";

/**
 * The only module that knows the Router URL and ROUTER_ADMIN_TOKEN. Server components read with
 * `routerGet`, server actions write with `routerSend`, and the install log route handler uses
 * `routerStream`. Nothing here is imported by client code (`server-only` fails the build if it is).
 *
 * PORTAL_DATA=fixture serves recorded data from memory (tests, screenshots, no stack needed).
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

const routerUrl = () => process.env.ROUTER_URL ?? "http://127.0.0.1:8100";
export const fixtureMode = () => process.env.PORTAL_DATA === "fixture";

function adminHeader(): Record<string, string> {
  const token = process.env.ROUTER_ADMIN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function messageOf(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => (d as { msg?: string }).msg ?? "invalid").join("; ");
  return fallback;
}

async function call<T>(method: string, path: string, body: unknown, admin: boolean, timeoutMs: number): Promise<Result<T>> {
  if (fixtureMode()) return fixtures.handle<T>(method, path, body);
  if (admin && !process.env.ROUTER_ADMIN_TOKEN) {
    return { ok: false, status: 500, error: "ROUTER_ADMIN_TOKEN is not set for the portal. See docs/m1b.md." };
  }
  try {
    const res = await fetch(routerUrl() + path, {
      method,
      cache: "no-store",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(admin ? adminHeader() : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { ok: false, status: res.status, error: messageOf(json, `Router returned ${res.status}`) };
    return { ok: true, data: json as T };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return {
      ok: false,
      status: 503,
      error: timedOut ? "The router took too long to answer." : "The router is not reachable. Is the stack running? (scripts/doctor.sh)",
    };
  }
}

export const routerGet = <T>(path: string) => call<T>("GET", path, undefined, false, 15_000);

/** Admin-token writes. `timeoutMs` is long for key validation and installs. */
export const routerSend = <T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs = 60_000) =>
  call<T>(method, path, body, true, timeoutMs);

/** Server-sent events from an install job, passed through unchanged. */
export async function routerStream(path: string, signal: AbortSignal): Promise<Response> {
  if (fixtureMode()) return fixtures.stream(path);
  const token = process.env.ROUTER_ADMIN_TOKEN;
  if (!token) return new Response("ROUTER_ADMIN_TOKEN is not set", { status: 500 });
  try {
    const up = await fetch(routerUrl() + path, { headers: adminHeader(), cache: "no-store", signal });
    if (!up.ok || !up.body) return new Response("install job not found", { status: up.status === 200 ? 502 : up.status });
    return new Response(up.body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
    });
  } catch {
    return new Response("router unreachable", { status: 503 });
  }
}
