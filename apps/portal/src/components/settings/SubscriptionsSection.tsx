"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { saveSubscriptions } from "@/app/settings/actions";
import type { SubscriptionItem } from "@/lib/metrics-types";
import { tMet } from "@/i18n/metrics";
import { Section } from "./Section";

interface Row {
  key: number;
  name: string;
  fee: string;
  start: string;
  end: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const input = "min-h-(--ctl) w-full rounded-control border border-hairline bg-glass-strong px-3 tabular-nums";

/** Settings → Subscriptions (M6): what you pay monthly, so Metrics can show savings after fees. */
export default function SubscriptionsSection({ items }: { items: SubscriptionItem[] }) {
  const { push } = useToast();
  const toRows = (xs: SubscriptionItem[]): Row[] =>
    xs.map((s, i) => ({ key: i, name: s.name, fee: String(s.monthly_usd), start: s.start, end: s.end ?? "" }));
  const [rows, setRows] = React.useState<Row[]>(() => toRows(items));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed: SubscriptionItem[] = [];
    for (const r of rows) {
      const fee = Number(r.fee.replace(/^\$/, "").trim());
      if (!r.name.trim() || r.fee.trim() === "" || !Number.isFinite(fee) || fee < 0 || fee > 10_000 || !r.start || (r.end && r.end < r.start)) {
        return setError(tMet("subs.invalid"));
      }
      parsed.push({ name: r.name.trim(), monthly_usd: fee, start: r.start, end: r.end || null });
    }
    setBusy(true);
    setError(null);
    const res = await saveSubscriptions(parsed);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setRows(toRows(res.data.items));
    push({ tone: "success", title: tMet("subs.saved") });
  };

  return (
    <Section id="subscriptions" title={tMet("subs.section")} explain={tMet("subs.explain")}>
      <p className="text-sm text-ink-muted">{tMet("subs.lead")}</p>
      <form className="grid gap-4" onSubmit={submit} noValidate>
        {rows.length === 0 && <p className="text-sm text-ink-muted">{tMet("subs.none")}</p>}
        <ul className="grid gap-3">
          {rows.map((r) => (
            <li key={r.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <label className="grid gap-1 text-sm font-semibold">
                {tMet("subs.name")}
                <input className={input} value={r.name} maxLength={60} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="Claude Pro" />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {tMet("subs.fee")}
                <input className={input} inputMode="decimal" value={r.fee} onChange={(e) => set(r.key, { fee: e.target.value })} placeholder="20" />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {tMet("subs.start")}
                <input className={input} type="date" value={r.start} onChange={(e) => set(r.key, { start: e.target.value })} />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {tMet("subs.end")}
                <input className={input} type="date" value={r.end} min={r.start || undefined} onChange={(e) => set(r.key, { end: e.target.value })} />
              </label>
              <Button type="button" size="icon" variant="ghost" aria-label={tMet("subs.remove", { name: r.name || "—" })} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" id={`${ids}-err`} className="text-sm text-err">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="glass" disabled={rows.length >= 20} onClick={() => setRows((rs) => [...rs, { key: Math.max(-1, ...rs.map((r) => r.key)) + 1, name: "", fee: "", start: today(), end: "" }])}>
            <Plus aria-hidden className="size-4" /> {tMet("subs.add")}
          </Button>
          <Button type="submit" size="sm" loading={busy}>
            {tMet("subs.save")}
          </Button>
        </div>
      </form>
    </Section>
  );
}
