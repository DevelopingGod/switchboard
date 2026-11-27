"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dial } from "@/components/kit/Dial";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { count, ms, pct, slotLabel, usd, when } from "@/lib/metrics-format";
import type { BreakdownBy, BreakdownPage, BreakdownRow, BudgetsView, Forecast, MetricsSummary, QuotaProvider, TopRequest, TopRequestsPage } from "@/lib/metrics-types";
import { tMet } from "@/i18n/metrics";
import { BarChart, DataTable, LineChart } from "./charts";
import { fetchView } from "@/lib/metrics-client";
import { WindowMeter } from "@/components/jobs/WindowMeter";
import type { SubscriptionView } from "@/lib/router-types";
import { tSubs } from "@/i18n/subscriptions";
import { tPacks } from "@/i18n/packs";
import type { PackMetrics } from "@/lib/packs-types";

const BYS: BreakdownBy[] = ["provider", "model", "agent", "rule", "intent", "project", "kind"];

interface Props {
  summary: MetricsSummary;
  range: string;
  /** M6.5: a custom range's first and last day. */
  days?: { first: string; last: string };
  tz: string;
  demo: boolean;
  onDemo: (v: boolean) => void;
  empty: boolean;
}

function useView<T>(view: string, params: Record<string, string | undefined>) {
  const [state, setState] = React.useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const key = JSON.stringify([view, params]);
  React.useEffect(() => {
    let live = true;
    const [v, p] = JSON.parse(key) as [string, Record<string, string | undefined>];
    void fetchView<T>(v, p).then((r) => live && setState(r.ok ? { data: r.data, error: null } : { data: null, error: r.error }));
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

function Panel({ id, title, lead, children }: { id: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={id} className="grid content-start gap-3">
      <h2 id={id} className="font-display text-xl font-bold tracking-tight">
        {title}
      </h2>
      {lead && <p className="text-sm text-ink-muted">{lead}</p>}
      {children}
    </GlassPanel>
  );
}

function Loading({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-err">
      {tMet("pro.error", { error })}
    </p>
  ) : (
    <p className="text-sm text-ink-muted">{tMet("pro.loading")}</p>
  );
}

export default function MetricsPro({ summary, range, tz, demo, onDemo, empty, days }: Props) {
  // `range` is the CSV tag ("2026-11-01_2026-11-20" for a custom range); requests send the key and days.
  const base = days
    ? { range: "custom", first: days.first, last: days.last, tz, include_demo: String(demo), empty: empty ? "1" : undefined }
    : { range, tz, include_demo: String(demo), empty: empty ? "1" : undefined };
  const unit = summary.range.slot;
  const labels = summary.series.map((p) => slotLabel(p.slot, unit));
  const unitWord = tMet(unit === "hour" ? "chart.unitHour" : "chart.unitDay");
  const s = summary.series;
  const t = summary.totals;
  return (
    <div className="grid gap-6">
      <label className="inline-flex min-h-8 items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={demo} onChange={(e) => onDemo(e.target.checked)} className="size-4 accent-(--accent-strong)" />
        {tMet("includeDemo")}
      </label>

      <Breakdown base={base} range={range} />

      <div className="grid gap-6">
        <GlassPanel as="section" tone="strong">
          <BarChart
            title={tMet("chart.trafficTitle")}
            caption={`${tMet("chart.trafficCaption", { unit: unitWord })} ${tMet("series.fallbacks")}: ${count(t.fallbacks)}.`}
            summary={`${count(t.rate_limited)} rate limits, ${count(t.timeouts)} timeouts and ${count(t.errors)} failed requests; ${count(t.fallbacks)} fallbacks.`}
            labels={labels}
            layout="stacked"
            series={[
              { key: "rl", label: tMet("series.rateLimited"), slot: 1, values: s.map((p) => p.rate_limited) },
              { key: "to", label: tMet("series.timeouts"), slot: 2, values: s.map((p) => p.timeouts) },
              { key: "err", label: tMet("series.errors"), slot: 3, values: s.map((p) => p.errors) },
            ]}
            format={(v) => count(v ?? 0)}
            axisFormat={(v) => String(v)}
            csvName="errors"
            range={range}
          />
        </GlassPanel>
        <GlassPanel as="section" tone="strong">
          <LineChart
            title={tMet("chart.latencyTitle")}
            caption={tMet("chart.latencyCaption", { unit: unitWord })}
            summary={`Response time per ${unitWord}: median and 95th percentile.`}
            labels={labels}
            series={[
              { key: "p50", label: tMet("series.p50"), slot: 1, values: s.map((p) => p.p50_ms) },
              { key: "p95", label: tMet("series.p95"), slot: 3, values: s.map((p) => p.p95_ms) },
            ]}
            format={(v) => ms(v)}
            axisFormat={(v) => (v === 0 ? "0" : v >= 1000 ? `${v / 1000}s` : `${v}ms`)}
            csvName="latency"
            range={range}
          />
        </GlassPanel>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Quotas tz={tz} />
        <Budgets tz={tz} />
      </div>

      <div className="grid gap-6">
        <Feedback base={base} range={range} />
        <JobsByAgent base={base} range={range} />
        <GraphPacks range={range} />
      </div>

      <TopRequests base={base} range={range} tz={tz} />
    </div>
  );
}

function money(r: BreakdownRow) {
  return [usd(r.spent_usd), usd(r.value_usd)];
}

function Breakdown({ base, range }: { base: Record<string, string | undefined>; range: string }) {
  const [by, setBy] = React.useState<BreakdownBy>("provider");
  const [rows, setRows] = React.useState<BreakdownRow[]>([]);
  const [next, setNext] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(true);
  const id = React.useId();
  const key = JSON.stringify(base);

  const apply = React.useCallback((r: Awaited<ReturnType<typeof fetchView<BreakdownPage>>>, append: boolean) => {
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setRows((old) => (append ? [...old, ...r.data.items] : r.data.items));
    setNext(r.data.next);
  }, []);
  const page = React.useCallback(
    (b: BreakdownBy, cursor?: string) => fetchView<BreakdownPage>("breakdown", { ...(JSON.parse(key) as Record<string, string>), by: b, cursor, limit: "25" }),
    [key],
  );
  React.useEffect(() => {
    let live = true;
    void page(by).then((r) => live && apply(r, false));
    return () => {
      live = false;
    };
  }, [by, page, apply]);
  const more = async (cursor: string) => {
    setBusy(true);
    apply(await page(by, cursor), true);
  };

  const jobsish = by === "agent" || by === "project";
  const header = [
    tMet(`pro.byLabel.${by}`),
    ...(jobsish ? [tMet("col.done"), tMet("col.failed"), tMet("col.success")] : [tMet("col.requests"), tMet("col.errors"), tMet("col.rate429"), tMet("col.timeouts"), tMet("col.fallbacks"), tMet("col.p50"), tMet("col.p95"), tMet("col.tokens")]),
    tMet("col.spent"),
    tMet("col.value"),
  ];
  const cells = (r: BreakdownRow) =>
    jobsish
      ? [r.jobs_done, r.jobs_failed, r.job_success_rate]
      : [r.requests, r.errors, r.rate_limited, r.timeouts, r.fallbacks, r.p50_ms, r.p95_ms, r.tokens_in + r.tokens_out];
  return (
    <Panel id={`${id}-h`} title={tMet("pro.breakdown")}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-by`} className="text-sm font-semibold">
          {tMet("pro.by")}
        </label>
        <select
          id={`${id}-by`}
          value={by}
          onChange={(e) => {
            setBusy(true);
            setBy(e.target.value as BreakdownBy);
          }}
          className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3 text-sm"
        >
          {BYS.map((b) => (
            <option key={b} value={b}>
              {tMet(`pro.byLabel.${b}`)}
            </option>
          ))}
        </select>
      </div>
      {error && !rows.length ? (
        <Loading error={error} />
      ) : (
        <DataTable
          caption={`${tMet("pro.breakdown")}: ${tMet(`pro.byLabel.${by}`)}`}
          header={header}
          rows={rows.map((r) => [
            r.label,
            ...(jobsish
              ? [count(r.jobs_done), count(r.jobs_failed), pct(r.job_success_rate)]
              : [count(r.requests), count(r.errors), count(r.rate_limited), count(r.timeouts), count(r.fallbacks), ms(r.p50_ms), ms(r.p95_ms), count(r.tokens_in + r.tokens_out)]),
            ...money(r),
          ])}
          csv={{ name: `breakdown-${by}`, range, rows: rows.map((r) => [r.label, ...cells(r), r.spent_usd, r.value_usd]) }}
        />
      )}
      {!busy && !rows.length && !error && <p className="text-sm text-ink-muted">{tMet("chart.empty")}</p>}
      {next && (
        <div>
          <Button size="sm" variant="glass" loading={busy} onClick={() => void more(next)}>
            {tMet("pro.loadMore")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Quotas({ tz }: { tz: string }) {
  const { data, error } = useView<{ providers: QuotaProvider[]; subscriptions?: SubscriptionView[] }>("quotas", {});
  return (
    <Panel id="met-quotas" title={tMet("pro.quotas")} lead={tMet("pro.quotasLead")}>
      {!data ? (
        <Loading error={error} />
      ) : !data.providers.length ? (
        <p className="text-sm text-ink-muted">{tMet("pro.quotasNone")}</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.providers.map((p) => {
            const w = p.windows[0];
            const frac = Math.min(1, w?.fraction ?? 0);
            return (
              <li key={p.provider} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                <Dial value={frac * 100} label={`${p.name} ${tMet(`pro.window.${w.window === "day" ? "day" : "minute"}`)}`} valueText={`${count(w.used)} of ${count(w.limit)} ${w.kind}`} size={64}>
                  <span className="text-[0.75rem] font-semibold tabular-nums">{pct(frac)}</span>
                </Dial>
                <div className="min-w-0 text-[0.8125rem]">
                  <p className="font-semibold">{p.name}</p>
                  {p.windows.map((x) => (
                    <p key={`${x.window}-${x.kind}-${x.source}`} className="text-ink-muted tabular-nums">
                      {count(x.used)} / {count(x.limit)} {x.kind} {tMet(`pro.window.${x.window === "day" ? "day" : "minute"}`)}
                      {x.estimate ? ` (${tMet("pro.estimate")})` : ""}
                      {x.resets_at ? ` · ${tMet("pro.resets", { when: when(x.resets_at, tz) })}` : ""}
                    </p>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data && <SubscriptionWindows subs={data.subscriptions ?? []} />}
    </Panel>
  );
}

/** M6.5: each subscription account's usage window now, and its limit hits in 30 days. */
function SubscriptionWindows({ subs }: { subs: SubscriptionView[] }) {
  return (
    <section aria-labelledby="met-subs" className="grid gap-3 border-t border-hairline pt-4">
      <h3 id="met-subs" className="font-display text-lg font-bold tracking-tight">
        {tSubs("metrics.title")}
      </h3>
      <p className="text-sm text-ink-muted">{tSubs("metrics.intro")}</p>
      {subs.length === 0 ? (
        <p className="text-sm text-ink-muted">{tSubs("metrics.none")}</p>
      ) : (
        <ul className="grid gap-4">
          {subs.map((s) => (
            <li key={`${s.cli}-${s.account}`} className="grid gap-1">
              <WindowMeter sub={s} pro />
              <p className="pl-[76px] text-[0.8125rem] text-ink-muted tabular-nums">{tSubs("metrics.hits", { n: s.limit_hits_30d ?? 0 })}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BudgetDial({ label, f, tz }: { label: string; f: Forecast; tz: string }) {
  const none = f.cap == null || f.state === "no_cap";
  const frac = none ? 0 : Math.min(1, f.fraction ?? 0);
  const text =
    f.state === "will_reach"
      ? tMet("pro.forecast.will_reach", { when: when(f.hits_at, tz) })
      : f.state === "no_cap"
        ? tMet("pro.forecast.no_cap")
        : tMet(`pro.forecast.${f.state}`, { when: when(f.resets_at, tz) });
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <Dial value={frac * 100} label={label} valueText={none ? tMet("pro.noCap") : `${usd(f.spent)} of ${usd(f.cap)}`} size={64}>
        <span className="text-[0.75rem] font-semibold tabular-nums">{none ? tMet("pro.noCap") : pct(frac)}</span>
      </Dial>
      <div className="min-w-0 text-[0.8125rem]">
        <p className="font-semibold">{label}</p>
        <p className="text-ink-muted tabular-nums">{none ? usd(f.spent) : `${usd(f.spent)} / ${usd(f.cap)}`}</p>
        <p className="text-ink-muted">{text}</p>
      </div>
    </li>
  );
}

function Budgets({ tz }: { tz: string }) {
  const { data, error } = useView<BudgetsView>("budgets", {});
  return (
    <Panel id="met-budgets" title={tMet("pro.budgets")} lead={data?.note}>
      {!data ? (
        <Loading error={error} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          <BudgetDial label={tMet("pro.chatCap")} f={data.chat} tz={tz} />
          {data.agents.flatMap((a) => [
            <BudgetDial key={`${a.agent}-d`} label={tMet("pro.agentToday", { agent: a.label })} f={a.today} tz={tz} />,
            <BudgetDial key={`${a.agent}-m`} label={tMet("pro.agentMonth", { agent: a.label })} f={a.month} tz={tz} />,
          ])}
        </ul>
      )}
    </Panel>
  );
}

function Feedback({ base, range }: { base: Record<string, string | undefined>; range: string }) {
  const { data, error } = useView<BreakdownPage>("breakdown", { ...base, by: "model", limit: "100" });
  const rows = (data?.items ?? []).filter((r) => r.thumbs_up + r.thumbs_down > 0);
  return (
    <Panel id="met-feedback" title={tMet("pro.feedback")}>
      {!data ? (
        <Loading error={error} />
      ) : !rows.length ? (
        <p className="text-sm text-ink-muted">{tMet("pro.feedbackNone")}</p>
      ) : (
        <DataTable
          caption={tMet("pro.feedback")}
          header={[tMet("col.model"), tMet("col.up"), tMet("col.down"), tMet("col.upRate")]}
          rows={rows.map((r) => [r.label, count(r.thumbs_up), count(r.thumbs_down), pct(r.thumbs_up_rate)])}
          csv={{ name: "feedback", range, rows: rows.map((r) => [r.label, r.thumbs_up, r.thumbs_down, r.thumbs_up_rate]) }}
        />
      )}
    </Panel>
  );
}

function JobsByAgent({ base, range }: { base: Record<string, string | undefined>; range: string }) {
  const { data, error } = useView<BreakdownPage>("breakdown", { ...base, by: "agent", limit: "100" });
  const rows = (data?.items ?? []).filter((r) => r.jobs_done + r.jobs_failed > 0);
  return (
    <Panel id="met-jobs" title={tMet("pro.jobs")}>
      {!data ? (
        <Loading error={error} />
      ) : !rows.length ? (
        <p className="text-sm text-ink-muted">{tMet("pro.jobsNone")}</p>
      ) : (
        <DataTable
          caption={tMet("pro.jobs")}
          header={[tMet("pro.byLabel.agent"), tMet("col.done"), tMet("col.failed"), tMet("col.success"), tMet("col.value")]}
          rows={rows.map((r) => [r.label, count(r.jobs_done), count(r.jobs_failed), pct(r.job_success_rate), usd(r.value_usd)])}
          csv={{ name: "jobs-by-agent", range, rows: rows.map((r) => [r.label, r.jobs_done, r.jobs_failed, r.job_success_rate, r.value_usd]) }}
        />
      )}
    </Panel>
  );
}

/** M4.5a (ADR 0019): whether graphify's code graph saves tokens, per project + agent + workflow. */
function GraphPacks({ range }: { range: string }) {
  const { data, error } = useView<PackMetrics>("packs", {});
  const m = data?.measure;
  const tok = (n: number | null) => (n == null ? "—" : count(Math.round(n)));
  return (
    <Panel
      id="met-graph"
      title={tPacks("metrics.title")}
      lead={m ? tPacks("metrics.lead", { every: m.holdout_every, n: m.min_samples, gain: Math.round(m.min_gain * 100) }) : undefined}
    >
      {!data ? (
        <Loading error={error} />
      ) : !data.rows.length ? (
        <p className="text-sm text-ink-muted">{tPacks("metrics.empty")}</p>
      ) : (
        <>
          <DataTable
            caption={tPacks("metrics.title")}
            header={[
              tPacks("metrics.project"),
              tPacks("metrics.agent"),
              tPacks("metrics.flow"),
              tPacks("metrics.status"),
              tPacks("metrics.with"),
              tPacks("metrics.without"),
              tPacks("metrics.cachedWith"),
              tPacks("metrics.cachedWithout"),
              tPacks("metrics.samples"),
            ]}
            rows={data.rows.map((r) => [
              r.project,
              r.agent,
              r.flow ?? tPacks("metrics.plain"),
              r.status,
              tok(r.median_with),
              tok(r.median_without),
              tok(r.cached_with),
              tok(r.cached_without),
              `${r.samples_with} / ${r.samples_without}`,
            ])}
            csv={{
              name: "graphify-savings",
              range,
              rows: data.rows.map((r) => [r.project, r.agent, r.flow ?? "", r.status, r.median_with, r.median_without, r.cached_with, r.cached_without, r.samples_with, r.samples_without]),
            }}
          />
          {data.rows.some((r) => !r.cached_known) && <p className="text-[0.8125rem] text-ink-muted">{tPacks("metrics.cachedUnknown")}</p>}
        </>
      )}
    </Panel>
  );
}

function TopRequests({ base, range, tz }: { base: Record<string, string | undefined>; range: string; tz: string }) {
  const [items, setItems] = React.useState<TopRequest[]>([]);
  const [next, setNext] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(true);
  const key = JSON.stringify(base);
  const page = React.useCallback(
    (cursor?: string) => fetchView<TopRequestsPage>("top-requests", { ...(JSON.parse(key) as Record<string, string>), cursor, limit: "20" }),
    [key],
  );
  const apply = React.useCallback((r: Awaited<ReturnType<typeof fetchView<TopRequestsPage>>>, append: boolean) => {
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setError(null);
    setItems((old) => (append ? [...old, ...r.data.items] : r.data.items));
    setNext(r.data.next);
  }, []);
  React.useEffect(() => {
    let live = true;
    void page().then((r) => live && apply(r, false));
    return () => {
      live = false;
    };
  }, [page, apply]);
  const more = async (cursor: string) => {
    setBusy(true);
    apply(await page(cursor), true);
  };
  const kind = (k: string) => (["chat", "media", "job", "aux", "test", "external"].includes(k) ? tMet(`kind.${k as "chat"}`) : k);
  return (
    <Panel id="met-top" title={tMet("pro.top")} lead={tMet("pro.topLead")}>
      {error && !items.length ? (
        <Loading error={error} />
      ) : (
        <DataTable
          caption={tMet("pro.top")}
          header={[tMet("col.what"), tMet("col.when"), tMet("col.kind"), tMet("col.model"), tMet("col.tokens"), tMet("col.spent"), tMet("col.value")]}
          numeric={[false, false, false, false, true, true, true]}
          rows={items.map((i) => [
            i.job_id ? (
              <Link key="l" href={`/jobs/${i.job_id}`} className="text-accent-strong underline underline-offset-4">
                {i.label}
              </Link>
            ) : (
              i.label
            ),
            when(i.at, tz),
            kind(i.kind),
            <span key="m" className="block max-w-56 truncate" title={i.model ?? undefined}>
              {i.model ?? "—"}
            </span>,
            count(i.tokens),
            usd(i.spent_usd),
            usd(i.value_usd),
          ])}
          csv={{ name: "top-requests", range, rows: items.map((i) => [i.label, i.at, i.kind, i.provider, i.model, i.tokens, i.spent_usd, i.value_usd]) }}
        />
      )}
      {!busy && !items.length && !error && <p className="text-sm text-ink-muted">{tMet("chart.empty")}</p>}
      {next && (
        <div>
          <Button size="sm" variant="glass" loading={busy} onClick={() => void more(next)}>
            {tMet("pro.loadMore")}
          </Button>
        </div>
      )}
    </Panel>
  );
}
