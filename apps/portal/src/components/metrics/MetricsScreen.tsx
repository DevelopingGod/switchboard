"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { BarChart3, Info } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { Segmented } from "@/components/kit/Segmented";
import { StatCard } from "@/components/kit/StatCard";
import { usePrefs } from "@/lib/prefs";
import { count, usd, slotLabel } from "@/lib/metrics-format";
import { RANGE_KEYS, customRangeProblem, rangeTag, type MetricsSummary, type RangeKey } from "@/lib/metrics-types";
import { tMet } from "@/i18n/metrics";
import { BarChart } from "./charts";
import { fetchView } from "@/lib/metrics-client";

// Pro sections are their own chunk: Simple mode never downloads them.
const MetricsPro = dynamic(() => import("./MetricsPro"), { ssr: false });

function browserTz(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function MetricsScreen({ initial, empty }: { initial: MetricsSummary; empty?: boolean }) {
  const { mode } = usePrefs();
  const [data, setData] = React.useState(initial);
  const [range, setRange] = React.useState<RangeKey>((initial.range.key as RangeKey) ?? "7d");
  // M6.5 (M6 carry-over): a custom range, first..last in the viewer's time zone, at most 366 days.
  const [first, setFirst] = React.useState(initial.range.key === "custom" ? initial.range.first : "");
  const [last, setLast] = React.useState(initial.range.key === "custom" ? initial.range.last : "");
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [demo, setDemo] = React.useState(initial.include_demo);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const tz = data.range.tz;

  const load = React.useCallback(
    async (r: RangeKey, zone: string, withDemo: boolean, days?: { first: string; last: string }) => {
      setBusy(true);
      const res = await fetchView<MetricsSummary>("summary", {
        range: r,
        tz: zone,
        include_demo: String(withDemo),
        empty: empty ? "1" : undefined,
        ...(r === "custom" && days ? days : {}),
      });
      setBusy(false);
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
    },
    [empty],
  );

  // First visit: the server didn't know this browser's time zone yet. Remember it and reload in it.
  React.useEffect(() => {
    const z = browserTz();
    if (!z || z === initial.range.tz) return;
    document.cookie = `sb_tz=${encodeURIComponent(z)}; path=/; max-age=31536000; samesite=lax`;
    let live = true;
    const days = initial.range.key === "custom" ? { first: initial.range.first, last: initial.range.last } : {};
    void fetchView<MetricsSummary>("summary", { range: initial.range.key, tz: z, include_demo: String(initial.include_demo), empty: empty ? "1" : undefined, ...days }).then(
      (r) => live && r.ok && setData(r.data),
    );
    return () => {
      live = false;
    };
  }, [initial, empty]);

  const pick = (r: RangeKey) => {
    setRange(r);
    if (r === "custom") {
      // Start from the range on screen; nothing loads until "Show".
      setFirst((f) => f || data.range.first);
      setLast((l) => l || data.range.last);
      return;
    }
    const u = new URL(window.location.href);
    u.searchParams.set("range", r);
    u.searchParams.delete("first");
    u.searchParams.delete("last");
    window.history.replaceState(null, "", u);
    void load(r, tz, demo);
  };
  const applyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = customRangeProblem(first, last, new Date().toISOString().slice(0, 10));
    if (problem) return setRangeError(tMet(`range.${problem}`));
    setRangeError(null);
    const u = new URL(window.location.href);
    u.searchParams.set("range", "custom");
    u.searchParams.set("first", first);
    u.searchParams.set("last", last);
    window.history.replaceState(null, "", u);
    void load("custom", tz, demo, { first, last });
  };
  const toggleDemo = (v: boolean) => {
    setDemo(v);
    void load(range, tz, v, range === "custom" ? { first, last } : undefined);
  };
  const tag = rangeTag(range, data.range.first, data.range.last);

  const tt = data.totals;
  const nothing = tt.requests === 0 && tt.jobs_done === 0 && tt.jobs_failed === 0 && tt.value_usd === 0;
  const unit = data.range.slot;
  const labels = data.series.map((p) => slotLabel(p.slot, unit));
  const unitWord = tMet(unit === "hour" ? "chart.unitHour" : "chart.unitDay");

  return (
    <div className="grid gap-6" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={tMet("range.label")}
          value={range}
          options={RANGE_KEYS.map((k) => ({ value: k, label: tMet(`range.${k}`) }))}
          onChange={pick}
        />
        <p className="text-[0.8125rem] text-ink-muted" aria-live="polite">
          {busy ? tMet("updating") : tMet("tzNote", { tz })}
        </p>
      </div>
      {range === "custom" && (
        <form onSubmit={applyCustom} noValidate aria-label={tMet("range.custom")} className="surface-strong flex flex-wrap items-end gap-3 rounded-panel p-3">
          <label className="grid gap-1 text-sm font-semibold">
            {tMet("range.first")}
            <input type="date" value={first} max={last || undefined} onChange={(e) => setFirst(e.target.value)} className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3 tabular-nums" />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            {tMet("range.last")}
            <input type="date" value={last} min={first || undefined} onChange={(e) => setLast(e.target.value)} className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3 tabular-nums" />
          </label>
          <button type="submit" className="inline-flex min-h-(--ctl) items-center rounded-chip bg-accent px-4 text-sm font-semibold text-on-accent">
            {tMet("range.apply")}
          </button>
          {rangeError && (
            <p role="alert" className="basis-full text-sm text-err">
              {rangeError}
            </p>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-err">
          {tMet("pro.error", { error })}
        </p>
      )}

      <section aria-label={tMet("title")} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={tMet("stat.spent")} value={usd(tt.spent_usd)} hint={tMet("stat.spentHint")} />
        <StatCard label={tMet("stat.value")} value={usd(tt.value_usd)} hint={tMet("stat.valueHint")} />
        <StatCard
          label={tMet("stat.net")}
          value={usd(tt.net_saved_usd)}
          hint={tt.has_subscriptions ? tMet("stat.netHint", { fees: usd(tt.subscriptions_usd), spent: usd(tt.spent_usd) }) : tMet("stat.netNoSubs", { spent: usd(tt.spent_usd) })}
        />
        <StatCard label={tMet("stat.requests")} value={count(tt.requests)} hint={tMet("stat.requestsHint", { chats: count(tt.chats), errors: count(tt.errors) })} />
        <StatCard label={tMet("stat.jobs")} value={count(tt.jobs_done)} hint={tMet("stat.jobsHint", { failed: count(tt.jobs_failed) })} />
      </section>

      {nothing ? (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            title={tMet("empty.title")}
            body={tMet("empty.body")}
            icon={<BarChart3 aria-hidden className="size-6" />}
            action={
              <Link href="/chat" className="font-semibold text-accent-strong underline underline-offset-4">
                {tMet("empty.action")}
              </Link>
            }
          />
        </GlassPanel>
      ) : (
        <>
          <GlassPanel as="section" tone="strong" aria-labelledby="met-insights" className="grid gap-3">
            <h2 id="met-insights" className="font-display text-xl font-bold tracking-tight">
              {tMet("insights.title")}
            </h2>
            {data.insights.length ? (
              <ul className="grid gap-2">
                {data.insights.map((s) => (
                  <li key={s} className="flex gap-2">
                    <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-strong" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">{tMet("insights.none")}</p>
            )}
            {!demo && tt.demo_requests > 0 && <p className="text-[0.8125rem] text-ink-muted">{tMet("demoHidden", { n: tt.demo_requests })}</p>}
            {data.pending_buckets > 0 && <p className="text-[0.8125rem] text-ink-muted">{tMet("pending")}</p>}
          </GlassPanel>

          <GlassPanel as="section" tone="strong">
            <BarChart
              title={tMet("chart.spendTitle")}
              caption={tMet("chart.spendCaption", { unit: unitWord })}
              summary={`${tMet("chart.spendTitle")}: ${usd(tt.spent_usd)} spent, ${usd(tt.value_usd)} value at API prices over ${labels.length} ${unitWord}s.`}
              labels={labels}
              layout="grouped"
              series={[
                { key: "spent", label: tMet("series.spent"), slot: 1, values: data.series.map((p) => p.spent_usd) },
                { key: "value", label: tMet("series.value"), slot: 2, values: data.series.map((p) => p.value_usd) },
              ]}
              format={(v) => usd(v ?? 0)}
              axisFormat={(v) => (v === 0 ? "$0" : `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}`)}
              csvName="spend-and-value"
              range={tag}
            />
          </GlassPanel>
        </>
      )}

      {mode === "pro" && (
        <MetricsPro
          key={`${tag}-${tz}-${demo}`}
          summary={data}
          range={tag}
          days={range === "custom" ? { first: data.range.first, last: data.range.last } : undefined}
          tz={tz}
          demo={demo}
          onDemo={toggleDemo}
          empty={Boolean(empty)}
        />
      )}
    </div>
  );
}
