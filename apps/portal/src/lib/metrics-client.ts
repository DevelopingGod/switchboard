/** Client-side reads for /metrics through the same-origin route (src/app/api/metrics/route.ts). */

export async function fetchView<T>(view: string, params: Record<string, string | undefined>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const q = new URLSearchParams({ view });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  try {
    const r = await fetch(`/api/metrics?${q}`, { cache: "no-store" });
    const j = (await r.json()) as { ok: boolean; data?: T; error?: string };
    return j.ok ? { ok: true, data: j.data as T } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "The portal could not reach the router." };
  }
}
