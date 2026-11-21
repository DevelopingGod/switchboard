"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, ListChecks, ShieldAlert, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Dial } from "@/components/kit/Dial";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { Skeleton } from "@/components/kit/Skeleton";
import { useToast } from "@/components/kit/Toast";
import { createJob, loadJobChoices, loadProposal, previewJob } from "@/app/jobs/actions";
import type { AgentRow, AgentsResponse, JobPreview, ProjectRow } from "@/lib/router-types";
import { jobsStrings, tJobs } from "@/i18n/jobs";
import { tSubs } from "@/i18n/subscriptions";
import { usd } from "@/lib/job-format";
import { resetTime, sourceText, windowText } from "@/lib/subscription-format";

export interface NewJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt?: string;
  /** "Run as job" from a chat reply: the routing decision's proposal and traceability. */
  requestId?: number;
  initialProject?: number;
  initialAgents?: string[];
  initialAutonomy?: number;
}

type Err = { code?: string; detail?: string | null; text: string };

const NAMES = jobsStrings.autonomy.names;

function agentReason(a: AgentRow, level: number): string | null {
  if (a.paused) return `${a.label} is paused (Agents page: Resume)`;
  return a.levels[String(level)] ?? null;
}

/**
 * Start a job (M4b): choose the project, the agents in order (primary + fallbacks), the autonomy level and
 * a budget, then review exactly what will happen (the router's own preview, the same checks the job loop
 * makes) and confirm. Nothing starts before Confirm.
 */
export default function NewJobDialog({ open, onOpenChange, initialPrompt, requestId, initialProject, initialAgents, initialAutonomy }: NewJobDialogProps) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [choices, setChoices] = React.useState<{ agents: AgentsResponse; projects: ProjectRow[] } | null>(null);
  const [isPrivate, setPrivate] = React.useState(false);
  const [loadErr, setLoadErr] = React.useState<Err | null>(null);
  const [prompt, setPrompt] = React.useState(initialPrompt ?? "");
  const [project, setProject] = React.useState<number | null>(initialProject ?? null);
  const [chain, setChain] = React.useState<string[]>(initialAgents ?? []);
  const [level, setLevel] = React.useState<number>(initialAutonomy ?? 1);
  const [budget, setBudget] = React.useState("");
  const [preview, setPreview] = React.useState<JobPreview | null>(null);
  // M6.5: a paid-overflow job (only after "Paid — up to $X"); null = a normal job.
  const [paidBudget, setPaidBudget] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<null | "preview" | "create">(null);
  const [error, setError] = React.useState<Err | null>(null);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const [c, p] = await Promise.all([loadJobChoices(), requestId ? loadProposal(requestId) : Promise.resolve(null)]);
      if (!alive) return;
      if (!c.ok) return setLoadErr({ code: c.code ?? "error", detail: c.detail ?? c.error, text: c.error });
      const { agents, projects } = c.data;
      setChoices(c.data);
      setBudget((b) => b || String(agents.defaults.per_job_list_usd));
      setProject((cur) => cur ?? projects[0]?.id ?? null);
      if (p?.ok && p.data.private) setPrivate(true);
      const runnable = agents.agents.filter((a) => a.runnable);
      const known = (list: string[]) => list.filter((id) => runnable.some((a) => a.id === id));
      setChain((cur) => {
        if (known(cur).length) return known(cur);
        const proposed = p?.ok ? known(p.data.agents) : [];
        if (proposed.length) return proposed;
        return runnable.filter((a) => !a.paused && a.capabilities.includes("code") && !a.hired).map((a) => a.id).slice(0, 3);
      });
      if (initialAutonomy === undefined) {
        const lv = p?.ok && p.data.autonomy != null ? p.data.autonomy : null;
        if (lv !== null) setLevel(Math.min(2, lv));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const byId = React.useMemo(() => new Map((choices?.agents.agents ?? []).map((a) => [a.id, a])), [choices]);
  const primary = chain.length ? byId.get(chain[0]) : undefined;
  const offStops = React.useMemo(() => {
    const out: Record<number, string> = {};
    const why = primary?.levels["3"] ?? choices?.agents.templates.find((t) => t.runnable)?.levels["3"];
    if (why) out[3] = why;
    return out;
  }, [primary, choices]);
  const spare = (choices?.agents.agents ?? []).filter((a) => a.runnable && !chain.includes(a.id));

  const input = () => {
    const b = Number(budget.replace(/^\$/, "").trim());
    return {
      prompt,
      project_id: project ?? 0,
      agents: chain,
      autonomy: level,
      budget_list_usd: budget.trim() && Number.isFinite(b) ? b : undefined,
      ...(requestId ? { from_request_id: requestId } : {}),
      ...(paidBudget != null ? { paid_budget_usd: paidBudget } : {}),
    };
  };

  const previewPaid = async (amount: number) => {
    setBusy("preview");
    setError(null);
    setPaidBudget(amount);
    const r = await previewJob({ ...input(), paid_budget_usd: amount });
    setBusy(null);
    if (!r.ok) return setError({ code: r.code, detail: r.detail, text: r.error });
    setPreview(r.data);
  };

  const review = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("preview");
    setError(null);
    const r = await previewJob(input());
    setBusy(null);
    if (!r.ok) return setError({ code: r.code, detail: r.detail, text: r.error });
    setPreview(r.data);
  };

  const confirm = async () => {
    setBusy("create");
    setError(null);
    const r = await createJob(input());
    setBusy(null);
    if (!r.ok) return setError({ code: r.code, detail: r.detail, text: r.error });
    push({ tone: "success", title: tJobs("run.started", { id: r.data.id }) });
    onOpenChange(false);
    router.push(`/jobs/${r.data.id}`);
  };

  const move = (i: number) => setChain((c) => (i <= 0 ? c : [...c.slice(0, i - 1), c[i], c[i - 1], ...c.slice(i + 1)]));
  const remove = (i: number) => setChain((c) => c.filter((_, k) => k !== i));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,44rem)]" aria-describedby={`${ids}-lead`}>
        <DialogTitle className="heading pr-8">{requestId ? tJobs("run.title") : tJobs("run.titleNew")}</DialogTitle>
        <DialogDescription id={`${ids}-lead`} className="text-sm text-ink-muted">
          {tJobs("run.lead")}
        </DialogDescription>

        {loadErr ? (
          <ErrorNote live code={loadErr.code} detail={loadErr.detail} />
        ) : isPrivate ? (
          <p role="alert" className="flex items-start gap-2 rounded-control border border-warn p-3 text-sm">
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" /> {tJobs("run.private")}
          </p>
        ) : !choices ? (
          <div aria-busy className="grid gap-3">
            <p className="sr-only">{tJobs("run.loading")}</p>
            <Skeleton className="h-24 rounded-control" />
            <Skeleton className="h-10 rounded-control" />
            <Skeleton className="h-32 rounded-control" />
          </div>
        ) : preview ? (
          <div className="grid gap-4">
            <section aria-labelledby={`${ids}-what`} className="grid gap-2">
              <h3 id={`${ids}-what`} className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
                <ListChecks aria-hidden className="size-5 text-accent-strong" /> {tJobs("run.willHappen")}
              </h3>
              {preview.problem && (
                <p role="alert" className="rounded-control border border-err p-3 text-sm text-err">
                  <span className="font-semibold">{tJobs("run.problem")}: </span>
                  {preview.problem}
                </p>
              )}
              {preview.steps.length > 0 && (
                <ol className="grid list-decimal gap-1.5 pl-5 text-sm leading-relaxed">
                  {preview.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {preview.agents.some((a) => a.reason) && (
                <ul className="grid gap-1 text-[0.8125rem] text-ink-muted">
                  {preview.agents
                    .filter((a) => a.reason)
                    .map((a) => (
                      <li key={a.id}>{`${a.label}: ${a.reason}`}</li>
                    ))}
                </ul>
              )}
              {preview.agents.some((a) => a.window) && (
                <ul aria-label={tSubs("window.meter")} className="grid gap-1 text-[0.8125rem] text-ink-muted">
                  {preview.agents
                    .filter((a) => a.window)
                    .map((a) => (
                      <li key={a.id} suppressHydrationWarning>{`${a.label} (${a.account ?? tSubs("account.default")}): ${windowText(a.window)} · ${sourceText(a.window)}`}</li>
                    ))}
                </ul>
              )}
              {preview.waits_until && !preview.paid && (
                <p className="rounded-control border border-warn/40 p-3 text-sm" suppressHydrationWarning>
                  {tSubs("job.previewWaits", { at: resetTime(preview.waits_until) })}
                </p>
              )}
              {preview.waits_until && !preview.paid && preview.overflow?.ready && (
                <div>
                  <Button type="button" size="sm" variant="glass" loading={busy === "preview"} onClick={() => previewPaid(Math.min(1, preview.overflow?.left_usd ?? 1))}>
                    {tSubs("job.paid")}
                  </Button>
                </div>
              )}
            </section>
            {error && <p role="alert" className="text-sm text-err">{error.text}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPreview(null);
                  setPaidBudget(null);
                }}
              >
                {tJobs("run.back")}
              </Button>
              <Button type="button" size="sm" variant={preview.paid ? "danger" : undefined} disabled={!preview.ok} loading={busy === "create"} onClick={confirm}>
                {preview.paid ? tSubs("job.paidConfirm", { budget: usd(preview.paid_budget_usd ?? 0) }) : tJobs("run.confirm")}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={review} className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor={`${ids}-task`} className="text-sm font-semibold">
                {tJobs("run.task")}
              </label>
              <textarea
                id={`${ids}-task`}
                required
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={32000}
                rows={4}
                className="w-full rounded-control border border-hairline bg-glass-strong p-3 text-sm"
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor={`${ids}-project`} className="text-sm font-semibold">
                {tJobs("run.project")}
              </label>
              {choices.projects.length ? (
                <select
                  id={`${ids}-project`}
                  value={project ?? ""}
                  onChange={(e) => setProject(Number(e.target.value))}
                  className="min-h-(--ctl) max-w-full rounded-control border border-hairline bg-glass-strong px-3"
                >
                  {choices.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.name} (${p.path})`}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-ink-muted">
                  {tJobs("run.noProjects")}{" "}
                  <Link href="/settings/projects" className="font-semibold text-accent-strong underline underline-offset-4">
                    {tJobs("board.addProject")}
                  </Link>
                </p>
              )}
            </div>

            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold">{tJobs("run.agents")}</legend>
              <p className="text-[0.8125rem] text-ink-muted">{tJobs("run.agentsHelp")}</p>
              <ol className="grid gap-1.5">
                {chain.map((id, i) => {
                  const a = byId.get(id);
                  const why = a ? agentReason(a, level) : null;
                  return (
                    <li key={id} className="surface-strong flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-sm">
                      <span className="label w-20 shrink-0">{i === 0 ? tJobs("run.primary") : tJobs("run.fallback", { n: i })}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-semibold">{a?.label ?? id}</span>
                        {why && <span className="block text-[0.8125rem] text-warn">{tJobs("run.unavailable", { reason: why })}</span>}
                      </span>
                      {i > 0 && (
                        <Button type="button" size="icon" variant="ghost" aria-label={tJobs("run.moveUp", { agent: a?.label ?? id })} data-tip={tJobs("run.moveUp", { agent: a?.label ?? id })} onClick={() => move(i)} className="size-8">
                          <ArrowUp aria-hidden className="size-4" />
                        </Button>
                      )}
                      <Button type="button" size="icon" variant="ghost" aria-label={tJobs("run.remove", { agent: a?.label ?? id })} data-tip={tJobs("run.remove", { agent: a?.label ?? id })} onClick={() => remove(i)} className="size-8">
                        <X aria-hidden className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ol>
              {spare.length > 0 && chain.length < 8 && (
                <label className="flex flex-wrap items-center gap-2 text-sm" htmlFor={`${ids}-add`}>
                  <span className="font-semibold">{tJobs("run.add")}</span>
                  <select
                    id={`${ids}-add`}
                    value=""
                    onChange={(e) => e.target.value && setChain((c) => [...c, e.target.value])}
                    className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3"
                  >
                    <option value="">…</option>
                    {spare.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </fieldset>

            <div className="grid items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
              <Dial
                value={level}
                stops={NAMES}
                disabledStops={offStops}
                onChange={setLevel}
                label={tJobs("autonomy.label")}
                valueText={`${level}: ${NAMES[level]}`}
                size={112}
              />
              <div className="grid gap-1 text-sm">
                <p className="font-semibold">
                  {tJobs("autonomy.label")}: {level} · {NAMES[level]}
                </p>
                <p className="text-ink-muted">{jobsStrings.autonomy.help[level]}</p>
                {offStops[3] && <p className="text-[0.8125rem] text-ink-muted">{tJobs("autonomy.off", { reason: offStops[3] })}</p>}
              </div>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor={`${ids}-budget`} className="text-sm font-semibold">
                {tJobs("run.budget")}
              </label>
              <input
                id={`${ids}-budget`}
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                aria-describedby={`${ids}-bh`}
                className="min-h-(--ctl) w-36 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
              />
              <p id={`${ids}-bh`} className="text-[0.8125rem] text-ink-muted">
                {tJobs("run.budgetHelp")}
              </p>
            </div>

            {error && <p role="alert" className="text-sm text-err">{error.text}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" size="sm" disabled={!project || !chain.length || !prompt.trim()} loading={busy === "preview"}>
                {tJobs("run.review")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
