"use client";

import * as React from "react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { Button } from "@/components/ui/button";
import { loadLog, loadRuns } from "@/app/jobs/actions";
import { appendLog, emptyLog, type LogBuffer } from "@/lib/log-buffer";
import { prettyLine } from "@/lib/log-format";
import type { JobRun, JobView } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { type JobsKey, tJobs } from "@/i18n/jobs";

const MAX = 5000;

/**
 * The live log (the current run, from the job's SSE stream) plus a picker for earlier runs, read in
 * pages from the router. Lines live on a solid panel; at most 5,000 are kept (older ones are dropped
 * and counted). It follows new lines until you scroll up.
 */
export function JobLog({ job, live, state }: { job: JobView; live: LogBuffer; state: "idle" | "open" | "reconnecting" | "ended" }) {
  const [runs, setRuns] = React.useState<JobRun[] | null>(null);
  const [run, setRun] = React.useState<string>("live");
  const [older, setOlder] = React.useState<{ buf: LogBuffer; next: number | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ code?: string; detail?: string | null } | null>(null);
  const box = React.useRef<HTMLDivElement>(null);
  const follow = React.useRef(true);
  const ids = React.useId();

  // Latest values for the run-list callback below (it runs after the fetch, not during render).
  const latest = React.useRef({ run, state, liveLines: live.lines.length });
  React.useEffect(() => {
    latest.current = { run, state, liveLines: live.lines.length };
  });

  const page = React.useCallback(
    async (rid: string, offset: number, base: LogBuffer) => {
      setBusy(true);
      setError(null);
      const r = await loadLog(job.id, rid, offset);
      setBusy(false);
      if (!r.ok) return setError({ code: r.code ?? "error", detail: r.detail ?? r.error });
      setOlder({ buf: appendLog(base, rid, r.data.lines, MAX), next: r.data.next });
    },
    [job.id],
  );

  const choose = (rid: string) => {
    setRun(rid);
    setOlder(null);
    follow.current = true;
    if (rid !== "live") void page(rid, 0, emptyLog());
  };

  React.useEffect(() => {
    let alive = true;
    void loadRuns(job.id).then((r) => {
      if (!alive || !r.ok) return;
      setRuns(r.data.runs);
      // A finished (or not-yet-streamed) job: show its last run's output.
      const l = latest.current;
      if (l.run === "live" && l.state !== "open" && l.state !== "reconnecting" && !l.liveLines && r.data.runs.length) {
        choose(r.data.runs[r.data.runs.length - 1].run);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the job moves on, not on every render
  }, [job.id, job.run_id, job.status]);

  const buf = run === "live" ? live : (older?.buf ?? emptyLog());
  // Readable by default (the agent's words, commands, tools, results); every raw line on request.
  const [raw, setRaw] = React.useState(false);
  const shown = React.useMemo(
    () =>
      buf.lines.flatMap((l) => {
        if (raw) return [{ ...l, kind: "plain" as const }];
        const p = prettyLine(l.text);
        return p ? [{ key: l.key, stream: l.stream, text: p.text, kind: p.kind }] : [];
      }),
    [buf.lines, raw],
  );

  React.useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const status =
    run !== "live" ? null : state === "reconnecting" ? tJobs("log.reconnecting") : state === "ended" ? tJobs("log.ended") : !live.lines.length ? tJobs("log.waiting") : null;

  return (
    <GlassPanel tone="strong" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label htmlFor={`${ids}-run`} className="grid gap-1 text-sm font-semibold">
          {tJobs("log.run")}
          <select
            id={`${ids}-run`}
            value={run}
            onChange={(e) => choose(e.target.value)}
            className="min-h-(--ctl) max-w-full rounded-control border border-hairline bg-glass-strong px-3 font-normal"
          >
            <option value="live">{tJobs("log.label")}</option>
            {(runs ?? []).map((r, i) => (
              <option key={r.run} value={r.run}>
                {`${i + 1}. ` + tJobs("log.runOption", { kind: tJobs(`timeline.kind.${r.kind ?? "edit"}` as JobsKey), status: r.status })}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {status && (
            <p role="status" className="text-sm text-ink-muted">
              {status}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} className="size-4 accent-[var(--accent-strong)]" />
            {tJobs("log.raw")}
          </label>
        </div>
      </div>
      {buf.dropped > 0 && <p className="text-[0.8125rem] text-ink-muted">{tJobs("log.trimmed", { n: buf.lines.length })}</p>}
      <div
        ref={box}
        role="log"
        aria-live="off"
        aria-label={tJobs("log.label")}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="solid-panel h-[min(28rem,60vh)] overflow-auto p-3 font-mono text-[0.75rem] leading-relaxed"
      >
        {buf.lines.length === 0 ? (
          <p className="text-(--solid-ink)">{busy ? tJobs("diff.loading") : tJobs("log.none")}</p>
        ) : (
          shown.map(({ key, stream, text, kind }) => (
            <div
              key={key}
              className={cn(
                "break-words whitespace-pre-wrap",
                stream === "stderr" ? "text-[#ffb4b4]" : stream === "system" ? "italic" : "",
                kind === "text" && "font-sans text-[0.8125rem]",
                kind === "result" && "font-semibold",
              )}
            >
              {text || " "}
            </div>
          ))
        )}
      </div>
      {run !== "live" && older?.next != null && (
        <Button type="button" size="sm" variant="glass" loading={busy} onClick={() => page(run, older.next!, older.buf)} className="w-fit">
          {tJobs("log.older")}
        </Button>
      )}
      {error && <ErrorNote live code={error.code} detail={error.detail} />}
    </GlassPanel>
  );
}
