import "server-only";
import * as fixtures from "./fixtures";
import * as chatFixtures from "./chat-fixtures";
import * as rulesFixtures from "./rules-fixtures";
import * as jobsFixtures from "./jobs-fixtures";
import * as metricsFixtures from "./metrics-fixtures";

/**
 * The only module that knows the Router URL and ROUTER_ADMIN_TOKEN. Server components read with
 * `routerGet`, server actions write with `routerSend`, and the install log route handler uses
 * `routerStream`. Nothing here is imported by client code (`server-only` fails the build if it is).
 *
 * PORTAL_DATA=fixture serves recorded data from memory (tests, screenshots, no stack needed).
 */

/** Failures carry the router's stable `code` (plain-language mapping in i18n/errors.ts) and the raw
 * `detail`, which the UI shows only in Pro mode. `error` is already a plain sentence. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number; code?: string; detail?: string | null; problems?: { path: string; message: string }[] };

const routerUrl = () => process.env.ROUTER_URL ?? "http://127.0.0.1:8100";
export const fixtureMode = () => process.env.PORTAL_DATA === "fixture";

function adminHeader(): Record<string, string> {
  const token = process.env.ROUTER_ADMIN_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function failureOf(body: unknown, fallback: string): { error: string; code?: string; detail?: string | null; problems?: { path: string; message: string }[] } {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as { code?: string; message?: string; detail?: string | null; problems?: { path: string; message: string }[] };
    return { error: d.message ?? fallback, code: d.code, detail: d.detail ?? null, ...(Array.isArray(d.problems) ? { problems: d.problems } : {}) };
  }
  if (typeof detail === "string") return { error: detail, detail };
  if (Array.isArray(detail)) return { error: detail.map((d) => (d as { msg?: string }).msg ?? "invalid").join("; ") };
  return { error: fallback };
}

async function call<T>(method: string, path: string, body: unknown, admin: boolean, timeoutMs: number): Promise<Result<T>> {
  if (fixtureMode()) {
    if (path.startsWith("/rules") || path === "/route/dry-run") return rulesFixtures.handle<T>(method, path, body);
    if (/^\/(jobs|agents|projects)(\/|\?|$)/.test(path)) return jobsFixtures.handleJobs<T>(method, path, body);
    if (path.startsWith("/metrics/") || path.startsWith("/settings/subscriptions")) return metricsFixtures.handle<T>(method, path, body);
    return path.startsWith("/chat/") || path.startsWith("/route/")
      ? chatFixtures.handle<T>(method, path, body)
      : fixtures.handle<T>(method, path, body);
  }
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
    if (!res.ok) return { ok: false, status: res.status, ...failureOf(json, `Router returned ${res.status}`) };
    return { ok: true, data: json as T };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return {
      ok: false,
      status: 503,
      code: timedOut ? "router_slow" : "router_down",
      error: timedOut ? "The router took too long to answer." : "The router is not reachable. Is the stack running? (scripts/doctor.sh)",
    };
  }
}

export const routerGet = <T>(path: string) => call<T>("GET", path, undefined, false, 15_000);

/** Admin GET returning the raw body (exports: JSON or Markdown text), or null on any failure. */
export async function routerGetRaw(path: string): Promise<{ body: string; type: string } | null> {
  if (fixtureMode()) {
    const r = chatFixtures.handle<{ markdown?: string }>("GET", path, undefined);
    if (!r.ok) return null;
    return r.data.markdown !== undefined
      ? { body: r.data.markdown, type: "text/markdown; charset=utf-8" }
      : { body: JSON.stringify(r.data, null, 2), type: "application/json" };
  }
  const token = process.env.ROUTER_ADMIN_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(routerUrl() + path, { headers: adminHeader(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return { body: await res.text(), type: res.headers.get("content-type") ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Admin-token reads (chat history is private, so the router requires the token for it). */
export const routerGetAdmin = <T>(path: string) => call<T>("GET", path, undefined, true, 15_000);

/** Admin-token writes. `timeoutMs` is long for key validation and installs. */
export const routerSend = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown, timeoutMs = 60_000) =>
  call<T>(method, path, body, true, timeoutMs);

/**
 * A chat turn (SSE) POSTed to the router with the admin token, passed through unchanged. Aborting
 * `signal` (the browser's Stop or a closed tab) closes the upstream stream, which stops the reply.
 */
export async function routerChatStream(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  if (fixtureMode()) return chatFixtures.stream(path, body, signal);
  const token = process.env.ROUTER_ADMIN_TOKEN;
  if (!token) return new Response("ROUTER_ADMIN_TOKEN is not set", { status: 500 });
  try {
    const up = await fetch(routerUrl() + path, {
      method: "POST",
      headers: { ...adminHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    if (!up.ok || !up.body) {
      const json = (await up.json().catch(() => null)) as unknown;
      return Response.json(failureOf(json, `Router returned ${up.status}`), { status: up.status === 200 ? 502 : up.status });
    }
    return new Response(up.body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch {
    if (signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: "The router is not reachable. Is the stack running? (scripts/doctor.sh)" }, { status: 503 });
  }
}

/** Server-sent events from an install or agent job, passed through unchanged. `lastEventId` resumes an
 * agent job's log where the browser's EventSource stopped (the router reads it from Last-Event-ID). */
export async function routerStream(path: string, signal: AbortSignal, lastEventId?: string | null): Promise<Response> {
  if (fixtureMode()) return path.startsWith("/jobs/") ? jobsFixtures.streamJob(path, lastEventId ?? null) : fixtures.stream(path);
  const token = process.env.ROUTER_ADMIN_TOKEN;
  if (!token) return new Response("ROUTER_ADMIN_TOKEN is not set", { status: 500 });
  try {
    const headers: Record<string, string> = { ...adminHeader() };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const up = await fetch(routerUrl() + path, { headers, cache: "no-store", signal });
    if (!up.ok || !up.body) return new Response("job not found", { status: up.status === 200 ? 502 : up.status });
    return new Response(up.body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch {
    return new Response("router unreachable", { status: 503 });
  }
}
