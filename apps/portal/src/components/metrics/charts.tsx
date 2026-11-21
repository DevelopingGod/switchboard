"use client";

import * as React from "react";
import { BarChart3, Download, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { csvFilename, downloadCsv, toCsv, type Cell } from "@/lib/csv";
import { ticks } from "@/lib/metrics-format";
import { tMet } from "@/i18n/metrics";

/**
 * Hand-rolled SVG charts for Metrics (ADR 0011): no chart library, a few KB. Each chart is a <figure> with a
 * caption, a text summary for screen readers, a legend, series told apart by texture or dash as well as
 * colour, a hover/focus tooltip, and a "Show as table" switch that renders the same numbers (with CSV export).
 * Colours are the validated categorical slots in components.css (`.viz`, light and dark).
 */

export interface Series {
  key: string;
  label: string;
  /** 1..4: categorical slot (colour and texture). */
  slot: 1 | 2 | 3 | 4;
  values: (number | null)[];
}

interface FrameProps {
  title: string;
  caption: string;
  summary: string;
  labels: string[];
  series: Series[];
  format: (v: number | null) => string;
  csvName: string;
  range: string;
  children: (ctx: { hover: number | null; setHover: (i: number | null) => void }) => React.ReactNode;
}

const W = 640;
const H = 220;
const PAD = { l: 52, r: 12, t: 12, b: 28 };

function Frame({ title, caption, summary, labels, series, format, csvName, range, children }: FrameProps) {
  const [table, setTable] = React.useState(false);
  const [hover, setHover] = React.useState<number | null>(null);
  const id = React.useId();
  const exportCsv = () =>
    downloadCsv(
      csvFilename(csvName, range),
      toCsv(
        [tMet("chart.when"), ...series.map((s) => s.label)],
        labels.map((l, i) => [l, ...series.map((s) => s.values[i] as Cell)]),
      ),
    );
  return (
    <figure className="viz grid gap-3" aria-labelledby={`${id}-t`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-t`} className="font-display text-lg font-bold tracking-tight">
          {title}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="ghost" aria-pressed={table} onClick={() => setTable((v) => !v)}>
            {table ? <BarChart3 aria-hidden className="size-4" /> : <Table2 aria-hidden className="size-4" />}
            {table ? tMet("chart.showChart") : tMet("chart.showTable")}
          </Button>
          <Button size="sm" variant="ghost" onClick={exportCsv}>
            <Download aria-hidden className="size-4" /> {tMet("chart.export")}
            <span className="sr-only">: {title}</span>
          </Button>
        </div>
      </div>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-ink-muted" aria-label={`${title}: legend`}>
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="14" height="10" className="shrink-0">
                <rect width="14" height="10" rx="2" fill={`var(--series-${s.slot})`} />
                {s.slot % 2 === 0 && <rect width="14" height="10" rx="2" fill={`url(#viz-tex-${s.slot})`} />}
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      )}
      {table ? (
        <DataTable
          caption={title}
          header={[tMet("chart.when"), ...series.map((s) => s.label)]}
          rows={labels.map((l, i) => [l, ...series.map((s) => format(s.values[i]))])}
        />
      ) : (
        <div className="viz-surface relative rounded-panel p-2" onPointerLeave={() => setHover(null)}>
          <p className="sr-only">{summary}</p>
          {children({ hover, setHover })}
          {hover !== null && (
            <div
              role="status"
              className="viz-surface pointer-events-none absolute top-2 z-10 min-w-36 rounded-control border border-hairline px-2.5 py-1.5 text-[0.8125rem] shadow-lg"
              style={{ left: `clamp(0.5rem, calc(${((hover + 0.5) / Math.max(1, labels.length)) * 100}% - 4.5rem), calc(100% - 10rem))` }}
            >
              <p className="font-semibold">{labels[hover]}</p>
              {series.map((s) => (
                <p key={s.key} className="flex justify-between gap-3 tabular-nums">
                  <span className="text-ink-muted">{s.label}</span> <span>{format(s.values[hover])}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      <figcaption className="text-[0.8125rem] text-ink-muted">{caption}</figcaption>
    </figure>
  );
}

function Defs() {
  return (
    <defs>
      {[2, 4].map((n) => (
        <pattern key={n} id={`viz-tex-${n}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={`rotate(${n === 2 ? 45 : 135})`}>
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--viz-tex)" strokeWidth="2" />
        </pattern>
      ))}
    </defs>
  );
}

function Axis({ max, format }: { max: number; format: (v: number) => string }) {
  const ts = ticks(max);
  const top = ts[ts.length - 1] || 1;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  return (
    <g aria-hidden>
      {ts.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--viz-grid)" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="fill-ink-muted text-[11px] tabular-nums">
            {format(v)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ labels }: { labels: string[] }) {
  const n = labels.length;
  const every = Math.max(1, Math.ceil(n / 8));
  const bw = (W - PAD.l - PAD.r) / Math.max(1, n);
  return (
    <g aria-hidden>
      {labels.map((l, i) =>
        i % every === 0 || i === n - 1 ? (
          <text key={i} x={PAD.l + bw * (i + 0.5)} y={H - 8} textAnchor="middle" className="fill-ink-muted text-[11px]">
            {l}
          </text>
        ) : null,
      )}
    </g>
  );
}

function HitTargets({ n, setHover }: { n: number; setHover: (i: number | null) => void }) {
  const bw = (W - PAD.l - PAD.r) / Math.max(1, n);
  return (
    <g>
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={PAD.l + bw * i} y={0} width={bw} height={H} fill="transparent" onPointerEnter={() => setHover(i)} />
      ))}
    </g>
  );
}

export interface BarChartProps {
  title: string;
  caption: string;
  summary: string;
  labels: string[];
  series: Series[];
  /** grouped: side by side (different measures); stacked: parts of one total. */
  layout: "grouped" | "stacked";
  format: (v: number | null) => string;
  axisFormat: (v: number) => string;
  csvName: string;
  range: string;
}

export function BarChart(p: BarChartProps) {
  const n = p.labels.length;
  const totals = p.labels.map((_, i) =>
    p.layout === "stacked" ? p.series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(0, ...p.series.map((s) => s.values[i] ?? 0)),
  );
  const max = Math.max(0, ...totals);
  const top = ticks(max)[ticks(max).length - 1] || 1;
  const plotH = H - PAD.t - PAD.b;
  const bw = (W - PAD.l - PAD.r) / Math.max(1, n);
  const gap = Math.min(6, bw * 0.2);
  const inner = bw - gap * 2;
  const h = (v: number) => (plotH * v) / top;
  const base = H - PAD.b;
  return (
    <Frame {...p}>
      {({ hover, setHover }) => (
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={p.summary}>
          <Defs />
          <Axis max={max} format={p.axisFormat} />
          {p.labels.map((_, i) => {
            const x0 = PAD.l + bw * i + gap;
            if (p.layout === "grouped") {
              const w = inner / p.series.length;
              return (
                <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {p.series.map((s, k) => {
                    const v = s.values[i] ?? 0;
                    if (v <= 0) return null;
                    const bh = Math.max(1.5, h(v));
                    const x = x0 + w * k + 1;
                    return (
                      <g key={s.key}>
                        <rect x={x} y={base - bh} width={Math.max(1, w - 2)} height={bh} rx={Math.min(3, w / 3)} fill={`var(--series-${s.slot})`} />
                        {s.slot % 2 === 0 && <rect x={x} y={base - bh} width={Math.max(1, w - 2)} height={bh} rx={Math.min(3, w / 3)} fill={`url(#viz-tex-${s.slot})`} />}
                      </g>
                    );
                  })}
                </g>
              );
            }
            let acc = 0;
            return (
              <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                {p.series.map((s) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const y1 = base - h(acc);
                  acc += v;
                  const bh = Math.max(1.5, h(acc) - h(acc - v)) - 1;
                  return (
                    <g key={s.key}>
                      <rect x={x0} y={y1 - bh - 1} width={inner} height={bh} rx={2} fill={`var(--series-${s.slot})`} />
                      {s.slot % 2 === 0 && <rect x={x0} y={y1 - bh - 1} width={inner} height={bh} rx={2} fill={`url(#viz-tex-${s.slot})`} />}
                    </g>
                  );
                })}
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={base} y2={base} stroke="var(--viz-axis)" strokeWidth="1" aria-hidden />
          <XLabels labels={p.labels} />
          <HitTargets n={n} setHover={setHover} />
        </svg>
      )}
    </Frame>
  );
}

export function LineChart(p: Omit<BarChartProps, "layout">) {
  const n = p.labels.length;
  const max = Math.max(0, ...p.series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const top = ticks(max)[ticks(max).length - 1] || 1;
  const plotH = H - PAD.t - PAD.b;
  const bw = (W - PAD.l - PAD.r) / Math.max(1, n);
  const x = (i: number) => PAD.l + bw * (i + 0.5);
  const y = (v: number) => PAD.t + plotH * (1 - v / top);
  return (
    <Frame {...p}>
      {({ hover, setHover }) => (
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={p.summary}>
          <Axis max={max} format={p.axisFormat} />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--viz-axis)" strokeWidth="1" aria-hidden />}
          {p.series.map((s, k) => {
            // Break the line where there is no data (null), never draw through a gap.
            const parts: string[] = [];
            let cur = "";
            s.values.forEach((v, i) => {
              if (v == null) {
                if (cur) parts.push(cur);
                cur = "";
              } else cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
            });
            if (cur) parts.push(cur);
            return (
              <g key={s.key}>
                {parts.map((d, j) => (
                  <path key={j} d={d} fill="none" stroke={`var(--series-${s.slot})`} strokeWidth="2" strokeDasharray={k === 1 ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {s.values.map((v, i) =>
                  v != null && (hover === i || n <= 14) ? (
                    <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 3} fill={`var(--series-${s.slot})`} stroke="var(--surface-solid)" strokeWidth="2" />
                  ) : null,
                )}
              </g>
            );
          })}
          <XLabels labels={p.labels} />
          <HitTargets n={n} setHover={setHover} />
        </svg>
      )}
    </Frame>
  );
}

/** An accessible table with an optional CSV export (every Metrics table has one). */
export function DataTable({
  caption,
  header,
  rows,
  csv,
  numeric,
}: {
  caption: string;
  header: string[];
  rows: (string | number | React.ReactNode)[][];
  csv?: { name: string; range: string; rows: Cell[][] };
  numeric?: boolean[];
}) {
  return (
    <div className="grid gap-2">
      {csv && (
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => downloadCsv(csvFilename(csv.name, csv.range), toCsv(header, csv.rows))}>
            <Download aria-hidden className="size-4" /> {tMet("chart.export")}
            <span className="sr-only">: {caption}</span>
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-panel border border-hairline" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full border-collapse text-left text-[0.8125rem]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-hairline">
              {header.map((h, i) => (
                <th key={i} scope="col" className={`px-3 py-2 font-semibold whitespace-nowrap ${numeric?.[i] || (numeric === undefined && i > 0) ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-hairline last:border-0">
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row" className="max-w-72 truncate px-3 py-1.5 font-medium">
                      {c}
                    </th>
                  ) : (
                    <td key={j} className={`px-3 py-1.5 tabular-nums whitespace-nowrap ${numeric?.[j] || numeric === undefined ? "text-right" : ""}`}>
                      {c}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
