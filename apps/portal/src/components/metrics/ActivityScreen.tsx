"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Download, Search, X } from "lucide-react";
import { Segmented } from "@/components/kit/Segmented";
import { EmptyState } from "@/components/kit/EmptyState";
import { Button } from "@/components/ui/button";
import { ACTIVITY_KINDS, ACTIVITY_STATUSES, activityQuery, type ActivityFilters, type ActivityItem, type ActivityOptions, type ActivityPage } from "@/lib/activity-types";
import { usePrefs } from "@/lib/prefs";
import { usd } from "@/lib/metrics-format";
import { tMet, type MetricsKey } from "@/i18n/metrics";
import { cn } from "@/lib/cn";

// The "Why this?" dialog loads when a row is opened.
const ActivityWhy = dynamic(() => import("./ActivityWhy"), { ssr: false });

const RANGES = ["today", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

async function fetchPage(f: ActivityFilters, cursor?: string): Promise<{ ok: true; data: ActivityPage } | { ok: false; error: string }> {
  try {
    const r = await fetch(`/api/activity?${activityQuery(f, cursor ? { cursor } : {})}`, { cache: "no-store" });
    const j = (await r.json()) as { ok: boolean; data?: ActivityPage; error?: string };
    return j.ok ? { ok: true, data: j.data! } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "The portal could not reach the router." };
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ms(n: number | null): string | null {
  if (n === null) return null;
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function ActivityScreen({ initial, options, range: range0, tz }: { initial: ActivityPage; options: ActivityOptions; range: string; tz: string }) {
  const { mode } = usePrefs();
  const pro = mode === "pro";
  const [filters, setFilters] = React.useState<ActivityFilters>({ range: range0, tz });
  const [items, setItems] = React.useState<ActivityItem[]>(initial.items);
  const [next, setNext] = React.useState<string | null>(initial.next);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<ActivityItem | null>(null);
  const ids = React.useId();
  const first = React.useRef(true);

  const load = React.useCallback(async (f: ActivityFilters) => {
    setBusy(true);
    const r = await fetchPage(f);
    setBusy(false);
    if (r.ok) {
      setItems(r.data.items);
      setNext(r.data.next);
      setError(null);
    } else setError(r.error);
  }, []);

  // Reload when a filter changes (not on first render: the server sent page one).
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(filters);
  }, [filters, load]);

  // Title search: debounced.
  React.useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === (search.trim() || undefined) ? f : { ...f, q: search.trim() || undefined })), 300);
    return () => clearTimeout(id);
  }, [search]);

  const more = async () => {
    if (!next) return;
    setBusy(true);
    const r = await fetchPage(filters, next);
    setBusy(false);
    if (r.ok) {
      setItems((xs) => [...xs, ...r.data.items]);
      setNext(r.data.next);
    } else setError(r.error);
  };

  const set = (k: keyof ActivityFilters, v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }));
  const filtered = !!(filters.kind || filters.status || filters.model || filters.provider || filters.rule || filters.q);
  const csvHref = `/api/activity/csv?${activityQuery(filters)}`;

  const select = (k: "kind" | "status" | "model" | "provider" | "rule", values: readonly string[], label: (v: string) => string) => (
    <label className="grid gap-1 text-[0.8125rem] font-semibold">
      {tMet(`activity.${k}`)}
      <select
        value={filters[k] ?? ""}
        onChange={(e) => set(k, e.target.value)}
        className="min-h-(--ctl) max-w-56 rounded-control border border-hairline bg-glass-strong px-2 text-sm font-normal"
      >
        <option value="">{tMet("activity.any")}</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {label(v)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="grid gap-4" aria-busy={busy || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={tMet("range.label")}
          value={filters.range as Range}
          options={RANGES.map((k) => ({ value: k, label: tMet(`range.${k}`) }))}
          onChange={(r) => {
            const u = new URL(window.location.href);
            u.searchParams.set("range", r);
            window.history.replaceState(null, "", u);
            setFilters((f) => ({ ...f, range: r }));
          }}
        />
        <a href={csvHref} download className="inline-flex min-h-9 items-center gap-2 rounded-chip border border-hairline bg-glass-strong px-3.5 text-[0.8125rem] font-semibold hover:bg-pill-active" data-tip={tMet("activity.csvHint")}>
          <Download aria-hidden className="size-4" /> {tMet("activity.csv")}
        </a>
      </div>

      <section aria-label={tMet("activity.filters")} className="surface-strong grid gap-3 rounded-panel p-3">
        <div className="grid gap-1">
          <label htmlFor={`${ids}-q`} className="text-[0.8125rem] font-semibold">
            {tMet("activity.search")}
          </label>
          <span className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
            <input
              id={`${ids}-q`}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={80}
              aria-describedby={`${ids}-qh`}
              className="min-h-(--ctl) w-full rounded-control border border-hairline bg-glass-strong pr-3 pl-9 text-sm"
            />
          </span>
          <span id={`${ids}-qh`} className="text-xs text-ink-muted">
            {tMet("activity.searchHint")}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {select("kind", ACTIVITY_KINDS, (v) => tMet(`activity.kinds.${v}` as MetricsKey))}
          {select("status", ACTIVITY_STATUSES, (v) => tMet(`activity.statuses.${v}` as MetricsKey))}
          {select("provider", options.provider, (v) => v)}
          {select("model", options.model, (v) => v.split("/").slice(-1)[0])}
          {pro && select("rule", options.rule, (v) => v)}
          {filtered && (
            <Button type="button" size="sm" variant="ghost" onClick={() => (setSearch(""), setFilters({ range: filters.range, tz: filters.tz }))}>
              <X aria-hidden className="size-4" /> {tMet("activity.clear")}
            </Button>
          )}
        </div>
      </section>

      {error && (
        <p role="alert" className="text-sm text-err">
          {tMet("activity.error", { reason: error })}
        </p>
      )}

      {items.length === 0 && !busy ? (
        <EmptyState title={filtered ? tMet("activity.empty") : tMet("activity.noneYet")} body={filtered ? tMet("activity.emptyHint") : tMet("activity.intro")} />
      ) : (
        <ul aria-label={tMet("activity.title")} className="surface-strong divide-y divide-hairline rounded-panel" data-activity>
          {items.map((r) => (
            <Row key={r.id} r={r} pro={pro} onOpen={() => setOpen(r)} />
          ))}
        </ul>
      )}

      {next && (
        <div className="flex justify-center">
          <Button type="button" variant="glass" onClick={more} loading={busy}>
            {busy ? tMet("activity.loading") : tMet("activity.more")}
          </Button>
        </div>
      )}
      {open && <ActivityWhy item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Row({ r, pro, onOpen }: { r: ActivityItem; pro: boolean; onOpen: () => void }) {
  const bad = r.status === "error" || r.status === "failed";
  const model = r.model ? r.model.split("/").slice(-1)[0] : null;
  const meta = [
    tMet(`activity.kinds.${r.kind}` as MetricsKey),
    model && (r.provider ? `${r.provider} · ${model}` : model),
    pro && r.rule,
    r.priced ? (r.cost_usd > 0 ? usd(r.cost_usd) : `${tMet("activity.free")}, ${tMet("activity.value", { value: usd(r.value_usd) })}`) : null,
    ms(r.latency_ms),
    pro && r.fallbacks > 0 && tMet("activity.fallbacks", { n: r.fallbacks }),
  ].filter(Boolean) as string[];
  return (
    <li className="grid gap-1 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {r.kind === "job" && r.job_id ? (
          <Link href={`/jobs/${r.job_id}`} className="min-w-0 truncate font-semibold text-accent-strong underline-offset-4 hover:underline" data-tip-truncated>
            {r.label}
          </Link>
        ) : (
          <button type="button" onClick={onOpen} className="min-w-0 truncate text-left font-semibold underline-offset-4 hover:underline" data-tip-truncated aria-haspopup="dialog">
            {r.label}
          </button>
        )}
        <span className={cn("text-[0.8125rem] font-semibold", bad ? "text-err" : "text-ink-muted")}>
          {r.status ? tMet(`activity.statuses.${r.status}` as MetricsKey) : ""}
        </span>
        <time dateTime={r.at} className="ml-auto text-[0.8125rem] text-ink-muted tabular-nums">
          {when(r.at)}
        </time>
      </div>
      <p className="text-[0.8125rem] text-ink-muted">{meta.join(" · ")}</p>
    </li>
  );
}
