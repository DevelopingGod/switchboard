"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Circle, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { STAGES, collapse, failureSummary, progressOf, stageOf } from "@/lib/install-log";
import type { LogEntry } from "@/lib/router-types";
import { type ConnectionKey, tConn } from "@/i18n/connections";

export type InstallPhase = "running" | "ok" | "failed" | "cancelled" | "timeout";

interface Props {
  name: string;
  version: string;
  phase: InstallPhase;
  entries: LogEntry[];
  /** Shown under the success message (the "Log in next" steps). */
  next?: React.ReactNode;
  /** Message for failed installs when the router gave one. */
  error?: string | null;
  reconnecting?: boolean;
  headingAs?: "h3" | "h4";
}

/**
 * The install's progress, as a person wants to read it: stages, one progress bar, and either a
 * success state or an error summary. The raw log is in a collapsed "Details" section.
 * Presentational: the dialog feeds it entries; the gallery renders fixed states.
 */
export function InstallProgress({ name, version, phase, entries, next, error, reconnecting, headingAs: H = "h3" }: Props) {
  const lines = React.useMemo(() => collapse(entries), [entries]);
  const stage = stageOf(entries, phase);
  const percent = progressOf(entries);
  const failed = phase === "failed" || phase === "timeout";
  const fail = React.useMemo(() => (failed ? failureSummary(entries, 20) : null), [failed, entries]);
  const logRef = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines.length]);

  return (
    <div className="grid gap-4">
      <ol aria-label={tConn("install.stagesLabel")} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STAGES.map((s, i) => {
          const done = i < stage || (phase === "ok" && i <= stage);
          const active = i === stage && phase === "running";
          const broke = i === stage && (failed || phase === "cancelled");
          return (
            <li
              key={s}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-control border border-hairline bg-glass-strong px-2.5 py-2 text-sm",
                active && "border-accent-strong font-semibold",
                done && "text-ok",
                !done && !active && !broke && "text-ink-muted",
                broke && "text-err",
              )}
            >
              {done ? (
                <CheckCircle2 aria-hidden className="size-4 shrink-0" />
              ) : active ? (
                <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
              ) : broke ? (
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
              ) : (
                <Circle aria-hidden className="size-4 shrink-0" />
              )}
              <span>{tConn(`install.stage.${s}` as ConnectionKey)}</span>
              {done && <span className="sr-only">{tConn("install.stageDone")}</span>}
            </li>
          );
        })}
      </ol>

      {phase === "running" && percent !== null && (
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold">{tConn("install.progress", { pct: percent })}</span>
          </div>
          <div
            role="progressbar"
            aria-label={tConn("install.progressLabel")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2.5 overflow-hidden rounded-full bg-track"
          >
            <div className="h-full rounded-full bg-accent-strong transition-[width] duration-(--d-base)" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {reconnecting && <p className="text-sm text-ink-muted">{tConn("install.reconnecting")}</p>}

      {phase === "ok" && (
        <div role="status" className="grid gap-3">
          <p className="flex items-center gap-2 font-display text-lg font-bold tracking-tight text-ok">
            <CheckCircle2 aria-hidden className="size-6 shrink-0" />
            {tConn("install.successTitle", { name, version })}
          </p>
          {next}
        </div>
      )}

      {phase === "cancelled" && <p role="status" className="text-sm text-ink-muted">{tConn("install.cancelled")}</p>}

      {failed && fail && (
        <div role="alert" className="grid gap-2">
          <p className="flex items-start gap-2 font-semibold text-err">
            <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0" />
            <span>
              {phase === "timeout" ? tConn("install.timedOut") : (error ?? tConn("install.failedTitle"))}
              {fail.summary && <span className="mt-0.5 block text-sm font-normal text-ink">{fail.summary}</span>}
            </span>
          </p>
          <H className="label">{tConn("install.lastLines", { n: fail.lines.length })}</H>
          <pre className="solid-panel max-h-48 overflow-auto p-3 whitespace-pre-wrap" tabIndex={0} aria-label={tConn("install.lastLines", { n: fail.lines.length })}>
            {fail.lines.join("\n")}
          </pre>
        </div>
      )}

      <details className="group rounded-control border border-hairline bg-glass-strong">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-semibold">
          <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          {tConn("install.details")}
          <span className="font-normal text-ink-muted">· {tConn("install.detailsHint")}</span>
        </summary>
        <pre
          ref={logRef}
          role="log"
          aria-label={tConn("install.log")}
          tabIndex={0}
          className="solid-panel m-2 max-h-56 min-h-16 overflow-auto p-3 whitespace-pre-wrap"
        >
          {lines.length ? lines.map((l) => l.t).join("\n") : tConn("install.running")}
        </pre>
      </details>
    </div>
  );
}
