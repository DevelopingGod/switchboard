"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pause, Pencil, Play, RotateCcw, Trash2, UserPlus } from "lucide-react";
import { Dial } from "@/components/kit/Dial";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge, type Status } from "@/components/kit/StatusBadge";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { agentAction } from "@/app/jobs/actions";
import { usd } from "@/lib/job-format";
import type { AgentRow, AgentsResponse, ProjectRow } from "@/lib/router-types";
import { tJobs } from "@/i18n/jobs";

const AgentFormDialog = dynamic(() => import("./AgentFormDialog"), { ssr: false });

function stateOf(a: AgentRow): { status: Status; label: string } {
  if (!a.runnable) return { status: "offline", label: tJobs("fleet.notVerified") };
  if (!a.installed) return { status: "offline", label: tJobs("fleet.notInstalled") };
  if (a.logged_in === false) return { status: "warning", label: tJobs("fleet.loggedOut") };
  if (a.paused) return { status: "stopped", label: tJobs("fleet.paused") };
  if (a.current_job) return { status: "running", label: tJobs("fleet.busy") };
  return { status: "healthy", label: tJobs("fleet.available") };
}

function AgentCard({ a, onEdit, projects }: { a: AgentRow; onEdit: () => void; projects: ProjectRow[] }) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<null | "reset" | "delete">(null);
  const [error, setError] = React.useState<{ code?: string; detail?: string | null; text: string } | null>(null);
  const st = stateOf(a);
  const ids = React.useId();
  // M6: the Dial is this month against the agent's monthly budget; no budget = "No cap", never a percentage.
  const monthly = a.monthly_budget_list_usd;
  const monthPct = monthly != null && monthly > 0 ? Math.min(100, (a.month_list_usd / monthly) * 100) : 0;
  const allowed = a.allowed_project_ids ? projects.filter((p) => a.allowed_project_ids!.includes(p.id)).map((p) => p.name) : null;

  const run = async (action: "pause" | "resume" | "reset" | "delete") => {
    setBusy(action);
    setError(null);
    const r = await agentAction(a.id, action);
    setBusy(null);
    setConfirm(null);
    if (!r.ok) return setError({ code: r.code, detail: r.detail, text: r.error });
    push({ tone: "success", title: tJobs(action === "pause" ? "fleet.paused_toast" : action === "resume" ? "fleet.resumed_toast" : action === "reset" ? "fleet.reset_toast" : "fleet.deleted_toast", { agent: a.label }) });
    router.refresh();
  };

  return (
    <li>
      <GlassPanel as="article" tone="strong" aria-labelledby={`${ids}-h`} className="grid h-full content-start gap-3">
        <header className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-0.5">
            <h2 id={`${ids}-h`} className="truncate font-display text-lg font-bold tracking-tight">
              {a.label}
            </h2>
            <p className="text-[0.8125rem] text-ink-muted">
              {a.hired ? tJobs("fleet.hired", { template: a.template ?? "" }) : a.cli}
              {a.model ? ` · ${a.model}` : ""}
              {a.edited ? ` · ${tJobs("fleet.edited")}` : ""}
            </p>
          </div>
          <StatusBadge status={st.status} label={st.label} />
        </header>

        {a.role && <p className="line-clamp-2 text-sm text-ink-muted">{a.role}</p>}
        {a.note && !a.runnable && <p className="text-sm text-ink-muted">{a.note}</p>}

        {a.runnable && (
          <>
            <p className="min-w-0 text-sm">
              {a.current_job ? (
                <Link href={`/jobs/${a.current_job.id}`} className="block truncate font-semibold text-accent-strong underline underline-offset-4" data-tip-truncated={a.current_job.title}>
                  {tJobs("fleet.current", { title: a.current_job.title })}
                </Link>
              ) : (
                <span className="text-ink-muted">{tJobs("fleet.noCurrent")}</span>
              )}
            </p>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
              <Dial
                value={monthPct}
                label={tJobs("fleet.budgetMonth")}
                valueText={monthly != null ? tJobs("fleet.monthOf", { used: usd(a.month_list_usd), cap: usd(monthly) }) : tJobs("fleet.noMonthly")}
                size={64}
              >
                <span className="text-center text-[0.6875rem] leading-tight font-semibold tabular-nums">{monthly != null ? `${Math.round(monthPct)}%` : tJobs("fleet.noCap")}</span>
              </Dial>
              <dl className="grid gap-1 text-[0.8125rem]">
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="font-semibold">{tJobs("fleet.success")}:</dt>
                  <dd className="text-ink-muted tabular-nums">
                    {a.success.rate == null ? tJobs("fleet.noHistory") : tJobs("fleet.successRate", { pct: Math.round(a.success.rate * 100), n: a.success.done + a.success.failed })}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="font-semibold">{tJobs("fleet.month")}:</dt>
                  <dd className="text-ink-muted tabular-nums">
                    {a.cost === "none" ? tJobs("cost.notReported") : tJobs("fleet.monthText", { listed: usd(a.month_list_usd), spent: usd(a.month_cost_usd) })}
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="font-semibold">{tJobs("fleet.budgetMonth")}:</dt>
                  <dd className="text-ink-muted tabular-nums">{monthly != null ? usd(monthly) : tJobs("fleet.noMonthly")}</dd>
                </div>
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="font-semibold">{tJobs("fleet.today")}:</dt>
                  <dd className="text-ink-muted tabular-nums">{tJobs("fleet.todayText", { used: usd(a.spent_today_list_usd), cap: usd(a.daily_budget_list_usd) })}</dd>
                </div>
                <div className="flex flex-wrap gap-x-1.5">
                  <dt className="font-semibold">{tJobs("hire.projects")}:</dt>
                  <dd className="min-w-0 truncate text-ink-muted">{allowed ? allowed.join(", ") || "—" : tJobs("hire.allProjects")}</dd>
                </div>
              </dl>
            </div>
            <details className="text-[0.8125rem]">
              <summary className="cursor-pointer font-semibold text-ink-muted select-none">{tJobs("fleet.levels")}</summary>
              <ul className="mt-1 grid gap-0.5 text-ink-muted">
                {Object.entries(a.levels).map(([n, why]) => (
                  <li key={n}>{why ? tJobs("fleet.levelNo", { n, reason: why }) : tJobs("fleet.levelOk", { n })}</li>
                ))}
              </ul>
            </details>
          </>
        )}

        {confirm ? (
          <div role="alertdialog" aria-labelledby={`${ids}-c`} className="grid gap-2 rounded-control border border-hairline p-3 text-sm">
            <p id={`${ids}-c`}>{tJobs(confirm === "reset" ? "fleet.resetConfirm" : "fleet.deleteConfirm", { agent: a.label })}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="danger" loading={busy === confirm} onClick={() => run(confirm)}>
                {confirm === "reset" ? tJobs("fleet.reset") : tJobs("fleet.delete")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                {tJobs("fleet.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          a.runnable && (
            <footer className="mt-auto flex flex-wrap gap-2">
              {a.paused ? (
                <Button type="button" size="sm" variant="glass" loading={busy === "resume"} onClick={() => run("resume")}>
                  <Play aria-hidden className="size-4" /> {tJobs("fleet.resume")}
                </Button>
              ) : (
                <Button type="button" size="sm" variant="glass" loading={busy === "pause"} onClick={() => run("pause")}>
                  <Pause aria-hidden className="size-4" /> {tJobs("fleet.pause")}
                </Button>
              )}
              <Button type="button" size="sm" variant="glass" onClick={onEdit}>
                <Pencil aria-hidden className="size-4" /> {tJobs("fleet.edit")}
              </Button>
              {a.edited && !a.hired && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("reset")}>
                  <RotateCcw aria-hidden className="size-4" /> {tJobs("fleet.reset")}
                </Button>
              )}
              {a.hired && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm("delete")}>
                  <Trash2 aria-hidden className="size-4" /> {tJobs("fleet.delete")}
                </Button>
              )}
            </footer>
          )
        )}
        {error && <ErrorNote live code={error.code ?? "error"} detail={error.detail ?? error.text} />}
      </GlassPanel>
    </li>
  );
}

export function FleetScreen({ data, projects }: { data: AgentsResponse; projects: ProjectRow[] }) {
  const [form, setForm] = React.useState<null | { mode: "hire" } | { mode: "edit"; agent: AgentRow }>(null);
  return (
    <section aria-label={tJobs("fleet.label")} className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-ink-muted">{tJobs("fleet.intro")}</p>
        <Button type="button" size="sm" onClick={() => setForm({ mode: "hire" })}>
          <UserPlus aria-hidden className="size-4" /> {tJobs("fleet.hire")}
        </Button>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
        {data.agents.map((a) => (
          <AgentCard key={a.id} a={a} projects={projects} onEdit={() => setForm({ mode: "edit", agent: a })} />
        ))}
      </ul>
      {form && <AgentFormDialog open onOpenChange={(o) => !o && setForm(null)} templates={data.templates} projects={projects} agent={form.mode === "edit" ? form.agent : undefined} />}
    </section>
  );
}
