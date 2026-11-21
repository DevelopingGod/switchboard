/** Number and time formatting for Metrics (M6). Pure functions, unit-tested. */

export function usd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a === 0) return "$0";
  if (a < 0.01) return `${sign}<$0.01`;
  if (a < 1000) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}

export function count(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${Math.round(v / 1000)}k`;
  return Math.round(v).toLocaleString("en-US");
}

export function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;
}

export function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} s`;
}

/** A series slot ("2026-11-21T14:00:00", local wall time) as a short axis label. */
export function slotLabel(slot: string, unit: "hour" | "day"): string {
  const [d, t] = slot.split("T");
  if (unit === "hour") return (t ?? "00:00").slice(0, 5);
  const [, m, day] = d.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(day)} ${months[Number(m) - 1] ?? ""}`;
}

/** "18:00" in the viewer's zone (the router returns UTC ISO instants). */
export function clock(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

/** "today 18:00" / "Sat 05:30" relative to now, in the viewer's zone. */
export function when(iso: string | null | undefined, tz?: string, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: tz });
  const c = clock(iso, tz);
  if (day(d) === day(now)) return `today ${c}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", timeZone: tz })} ${c}`;
}

/** Nice axis ticks: 0..max in 3–5 round steps. */
export function ticks(max: number, target = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
