"use client";

import * as React from "react";
import { FileDiff as FileIcon, FilePlus2 } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { Button } from "@/components/ui/button";
import { loadDiff } from "@/app/jobs/actions";
import { languageOf, parseDiff, type FileDiff } from "@/lib/diff";
import type { JobDiff } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tJobs } from "@/i18n/jobs";
import { tPacks } from "@/i18n/packs";

type Highlighter = (code: string, lang: string | undefined) => string | null;

/** One file: collapsed by default; highlighting (highlight.js, its own chunk) runs only once it is opened. */
function FilePanel({ f, open, onToggle, hl }: { f: FileDiff; open: boolean; onToggle: (open: boolean) => void; hl: Highlighter | null }) {
  const lang = languageOf(f.path);
  return (
    <details open={open} onToggle={(e) => onToggle(e.currentTarget.open)} className="surface-strong overflow-hidden rounded-panel">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm select-none">
        {f.isNew ? <FilePlus2 aria-hidden className="size-4 shrink-0 text-ok" /> : <FileIcon aria-hidden className="size-4 shrink-0 text-ink-muted" />}
        <span className="min-w-0 flex-1 truncate font-mono font-semibold" data-tip-truncated={f.path}>
          {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        </span>
        {f.isNew && <span className="text-[0.75rem] text-ink-muted">{tJobs("diff.newFile")}</span>}
        <span className="font-mono text-[0.8125rem] tabular-nums">
          <span className="text-ok">+{f.added}</span> <span className="text-err">−{f.removed}</span>
        </span>
      </summary>
      {open &&
        (f.binary || !f.lines.length ? (
          <p className="border-t border-hairline px-4 py-3 text-sm text-ink-muted">{tJobs("diff.binary")}</p>
        ) : (
          <div className="solid-panel overflow-x-auto rounded-none border-0 border-t border-hairline" tabIndex={0} aria-label={f.path}>
            <table className="w-full border-collapse font-mono text-[0.75rem] leading-relaxed">
              <tbody>
                {f.lines.map((l, i) => {
                  const html = hl && (l.kind === "add" || l.kind === "del" || l.kind === "ctx") ? hl(l.text, lang) : null;
                  return (
                    <tr key={i} className={cn(l.kind === "add" && "diff-add", l.kind === "del" && "diff-del", l.kind === "hunk" && "diff-hunk")}>
                      <td aria-hidden={l.kind === "ctx" || undefined} className="w-6 pl-2 align-top select-none">
                        {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                      </td>
                      {html !== null ? (
                        <td className="pr-3 whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
                      ) : (
                        <td className="pr-3 whitespace-pre">{l.text}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </details>
  );
}

/** The job's changes, per file, on solid panels (M4b). Fetched only when this tab opens. */
const firstOpen = (d: JobDiff | null): Record<string, boolean> => {
  // A small change opens its first file at once; big ones start collapsed.
  const f = d ? parseDiff(d.diff) : [];
  return f.length && f.length <= 3 ? { [f[0].path]: true } : {};
};

interface SetupProps {
  editable: boolean;
  ticked: string[];
  onChange: (paths: string[]) => void;
}

/** M4.5a: what a pack's setup changed, apart from the agent's work: unticked (left out of the commit) by default. */
function SetupEdits({ data, setup, open, onToggle, hl }: { data: JobDiff; setup?: SetupProps; open: Record<string, boolean>; onToggle: (path: string, o: boolean) => void; hl: Highlighter | null }) {
  const edits = data.setup_edits ?? [];
  const files = React.useMemo(() => parseDiff(data.setup_diff ?? ""), [data.setup_diff]);
  if (!edits.length) return null;
  const byPack = new Map<string, typeof edits>();
  for (const e of edits) byPack.set(e.pack_name, [...(byPack.get(e.pack_name) ?? []), e]);
  const ticked = new Set(setup?.ticked ?? []);
  return (
    <>
      {[...byPack.entries()].map(([pack, list]) => (
        <section key={pack} aria-labelledby={`setup-${pack}`} className="grid gap-2 rounded-panel border border-warn/50 p-3">
          <h3 id={`setup-${pack}`} className="font-display text-base font-bold tracking-tight">
            {tPacks("diff.setupTitle", { pack })}
          </h3>
          <p className="text-sm text-ink-muted">{tPacks("diff.setupLead", { pack })}</p>
          {list.map((e) => {
            const f = files.find((x) => x.path === e.path);
            return (
              <div key={e.path} className="grid gap-1.5">
                <label className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={ticked.has(e.path)}
                    disabled={!setup?.editable}
                    onChange={(ev) => setup?.onChange(ev.target.checked ? [...ticked, e.path] : [...ticked].filter((x) => x !== e.path))}
                  />
                  <span className="font-mono font-semibold break-all">{e.path}</span>
                  <span className="text-[0.75rem] text-ink-muted">{tPacks(`diff.kind.${e.kind}`)}</span>
                </label>
                {e.both ? (
                  <p className="text-[0.8125rem] text-warn">{tPacks("diff.both")}</p>
                ) : e.agent_changed ? (
                  <p className="text-[0.8125rem] text-ink-muted">{tPacks("diff.agentToo")}</p>
                ) : null}
                {f && <FilePanel f={f} open={!!open[`setup:${f.path}`]} hl={hl} onToggle={(o) => onToggle(`setup:${f.path}`, o)} />}
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}

export default function DiffView({ jobId, initial = null, setup }: { jobId: number; initial?: JobDiff | null; setup?: SetupProps }) {
  const [data, setData] = React.useState<JobDiff | null>(initial);
  const [error, setError] = React.useState<{ code?: string; detail?: string | null; text: string } | null>(null);
  const [open, setOpen] = React.useState<Record<string, boolean>>(() => firstOpen(initial));
  const [hl, setHl] = React.useState<Highlighter | null>(null);

  React.useEffect(() => {
    if (initial) return; // rendered on the server with the page (no shift when it arrives)
    let alive = true;
    void loadDiff(jobId).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setData(r.data);
        setOpen(firstOpen(r.data));
      } else setError({ code: r.code ?? "error", detail: r.detail ?? r.error, text: r.error });
    });
    return () => {
      alive = false;
    };
  }, [jobId, initial]);

  const files = React.useMemo(() => (data ? parseDiff(data.diff) : []), [data]);
  const anyOpen = Object.values(open).some(Boolean);
  React.useEffect(() => {
    if (anyOpen && !hl) void import("@/lib/highlight").then((m) => setHl(() => m.highlight));
  }, [anyOpen, hl]);

  if (error)
    return (
      <GlassPanel tone="strong">
        <p className="text-sm text-ink-muted">{error.text}</p>
        <ErrorNote code={error.code} detail={error.detail} />
      </GlassPanel>
    );
  if (!data)
    return (
      <GlassPanel tone="strong" aria-busy>
        <p className="text-sm text-ink-muted">{tJobs("diff.loading")}</p>
      </GlassPanel>
    );
  if (!files.length && !(data.setup_edits ?? []).length)
    return (
      <GlassPanel tone="strong">
        <p className="text-sm text-ink-muted">{tJobs("diff.empty")}</p>
      </GlassPanel>
    );

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <section aria-label={tJobs("diff.label")} className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="font-semibold tabular-nums">
          {tJobs("diff.files", { n: files.length })} · <span className="text-ok">{tJobs("diff.added", { n: added })}</span> ·{" "}
          <span className="text-err">{tJobs("diff.removed", { n: removed })}</span>
        </p>
        <Button type="button" size="sm" variant="glass" onClick={() => setOpen(anyOpen ? {} : Object.fromEntries(files.map((f) => [f.path, true])))}>
          {anyOpen ? tJobs("diff.collapseAll") : tJobs("diff.expandAll")}
        </Button>
      </div>
      {data.truncated && (
        <p role="note" className="rounded-control border border-warn p-3 text-sm">
          {tJobs("diff.truncated")}
        </p>
      )}
      {files.map((f) => (
        <FilePanel key={f.path} f={f} open={!!open[f.path]} hl={hl} onToggle={(o) => setOpen((cur) => (!!cur[f.path] === o ? cur : { ...cur, [f.path]: o }))} />
      ))}
      <SetupEdits data={data} setup={setup} open={open} hl={hl} onToggle={(k, o) => setOpen((cur) => (!!cur[k] === o ? cur : { ...cur, [k]: o }))} />
    </section>
  );
}
