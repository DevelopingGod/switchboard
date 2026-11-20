"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, FolderGit2, Inbox } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { Button } from "@/components/ui/button";
import { loadJobsPage } from "@/app/jobs/actions";
import { badgeOf, costSummary } from "@/lib/job-format";
import type { JobCounts, JobStatus, JobView, JobsPage } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tJobs } from "@/i18n/jobs";
import { NewJobButton } from "./NewJobButton";

const TABS: readonly (JobStatus | "all")[] = ["all", "needs_approval", "running", "queued", "done", "failed", "stopped"];

export interface BoardFilters {
  status?: string;
  agent?: string;
  project?: number;
}

function href(f: BoardFilters): string {
  const sp = new URLSearchParams();
  if (f.status) sp.set("status", f.status);
  if (f.agent) sp.set("agent", f.agent);
  if (f.project) sp.set("project", String(f.project));
  const q = sp.toString();
  return q ? `/jobs?${q}` : "/jobs";
}

const timeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function JobRow({ j }: { j: JobView }) {
  const cost = costSummary(j);
  return (
    <li>
      <Link
        href={`/jobs/${j.id}`}
        aria-label={tJobs("row.open", { id: j.id, title: j.title })}
        className="job-row surface-strong grid gap-2 rounded-panel p-4 hover:-translate-y-px sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
      >
        <div className="grid min-w-0 gap-1">
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-[0.8125rem] text-ink-muted">#{j.id}</span>
            <span className="truncate font-semibold tracking-tight" data-tip-truncated={j.title}>
              {j.title}
            </span>
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-ink-muted">
            <span className="inline-flex items-center gap-1">
              <Bot aria-hidden className="size-3.5" /> {j.agent_label}
            </span>
            {j.project && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <FolderGit2 aria-hidden className="size-3.5" /> <span className="truncate">{j.project.name}</span>
              </span>
            )}
            <span>{tJobs("row.autonomy", { level: j.autonomy })}</span>
            <span suppressHydrationWarning>{timeFmt.format(new Date(j.created_at))}</span>
            <span className="tabular-nums">
              {cost.kind === "unreported" ? tJobs("cost.notReported") : tJobs("cost.listPrice", { amount: cost.listed })}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3 sm:justify-end">
          <StatusBadge status={badgeOf(j.status)} label={j.status === "needs_approval" && j.gate ? tJobs(`gate.${j.gate}`) : tJobs(`status.${j.status}`)} />
        </div>
      </Link>
    </li>
  );
}

export function JobBoard({
  initial,
  counts,
  filters,
  agents,
  projects,
}: {
  initial: JobsPage;
  counts: JobCounts;
  filters: BoardFilters;
  agents: { id: string; label: string }[];
  projects: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [jobs, setJobs] = React.useState(initial.jobs);
  const [next, setNext] = React.useState(initial.next);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ code?: string; detail?: string | null } | null>(null);
  const ids = React.useId();
  const filtered = !!(filters.agent || filters.project);

  const more = async () => {
    if (!next) return;
    setBusy(true);
    setError(null);
    const r = await loadJobsPage({ ...filters, before: next });
    setBusy(false);
    if (!r.ok) return setError({ code: r.code ?? "error", detail: r.detail ?? r.error });
    setJobs((cur) => cur.concat(r.data.jobs));
    setNext(r.data.next);
  };

  const total = filters.status ? counts.counts[filters.status as JobStatus] : counts.all;

  if (counts.all === 0 && !filtered) {
    return (
      <GlassPanel as="section" tone="strong">
        <EmptyState
          title={tJobs("board.emptyTitle")}
          body={projects.length ? tJobs("board.emptyBody") : `${tJobs("board.emptyBody")} ${tJobs("board.emptyProjects")}`}
          icon={<Inbox aria-hidden className="size-6" />}
          action={
            projects.length ? (
              <NewJobButton label={tJobs("board.sample")} prompt={tJobs("board.sampleTask")} />
            ) : (
              <Link href="/settings/projects" className="font-semibold text-accent-strong underline underline-offset-4">
                {tJobs("board.addProject")}
              </Link>
            )
          }
        />
      </GlassPanel>
    );
  }

  return (
    <section aria-label={tJobs("board.label")} className="grid gap-4">
      <nav aria-label={tJobs("filters.status")} className="surface-strong w-full overflow-hidden rounded-panel p-1">
        <ul className="flex flex-wrap gap-0.5">
          {TABS.map((s) => {
            const active = (filters.status ?? "all") === s;
            const n = s === "all" ? counts.all : counts.counts[s];
            return (
              <li key={s}>
                <Link
                  href={href({ ...filters, status: s === "all" ? undefined : s })}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-1.5 rounded-chip px-3 text-sm",
                    active ? "bg-pill-active font-bold text-ink ring-1 ring-accent-strong/30" : "font-medium text-ink-muted hover:text-ink",
                  )}
                >
                  {tJobs(`status.${s}`)}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[0.75rem] font-semibold tabular-nums",
                      s === "needs_approval" && n > 0 ? "bg-warn/15 text-warn" : "bg-track text-ink-muted",
                    )}
                  >
                    {n}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <form aria-label={tJobs("filters.label")} className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
        <label className="grid gap-1 text-sm font-semibold" htmlFor={`${ids}-a`}>
          {tJobs("filters.agent")}
          <select
            id={`${ids}-a`}
            value={filters.agent ?? ""}
            onChange={(e) => router.push(href({ ...filters, agent: e.target.value || undefined }))}
            className="min-h-(--ctl) max-w-full rounded-control border border-hairline bg-glass-strong px-3 font-normal"
          >
            <option value="">{tJobs("filters.anyAgent")}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold" htmlFor={`${ids}-p`}>
          {tJobs("filters.project")}
          <select
            id={`${ids}-p`}
            value={filters.project ? String(filters.project) : ""}
            onChange={(e) => router.push(href({ ...filters, project: e.target.value ? Number(e.target.value) : undefined }))}
            className="min-h-(--ctl) max-w-full rounded-control border border-hairline bg-glass-strong px-3 font-normal"
          >
            <option value="">{tJobs("filters.anyProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <Link href={href({ status: filters.status })} className="mb-2 text-sm font-semibold text-accent-strong underline underline-offset-4">
            {tJobs("filters.clear")}
          </Link>
        )}
      </form>

      {jobs.length === 0 ? (
        <GlassPanel tone="strong">
          <p className="text-ink-muted">{tJobs("board.noMatch")}</p>
        </GlassPanel>
      ) : (
        <ul className="grid gap-2.5">
          {jobs.map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-ink-muted tabular-nums" aria-live="polite">
          {tJobs("board.countOf", { shown: jobs.length, total })}
        </p>
        {next && (
          <Button type="button" size="sm" variant="glass" loading={busy} onClick={more}>
            {tJobs("board.loadMore")}
          </Button>
        )}
      </div>
      {error && <ErrorNote live code={error.code} detail={error.detail} />}
    </section>
  );
}

