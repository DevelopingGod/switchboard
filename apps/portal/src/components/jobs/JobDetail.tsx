"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Bot, Check, ExternalLink, FolderGit2, GitBranch, Gauge, Square, X } from "lucide-react";
import { Dial } from "@/components/kit/Dial";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { CopyButton } from "@/components/kit/CopyButton";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/Markdown";
import { approveJob, rejectJob, stopJob } from "@/app/jobs/actions";
import { appendLog, emptyLog, type LogBuffer } from "@/lib/log-buffer";
import { badgeOf, budgetPct, costSummary, duration, isActive, usd } from "@/lib/job-format";
import type { JobDiff, JobView } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { jobsStrings, tJobs } from "@/i18n/jobs";
import { JobTimeline } from "./JobTimeline";
import { JobLog } from "./JobLog";
import { MessageAttachments } from "@/components/chat/MessageAttachments";
import { MergeHelp } from "./MergeHelp";
import { tSubs } from "@/i18n/subscriptions";

// The diff viewer is its own chunk. When a job waits on its changes they come with the page (server
// render, no shift); otherwise they load when the Changes tab opens.
const DiffView = dynamic(() => import("./DiffView"), { loading: () => <p className="text-sm text-ink-muted">{tJobs("diff.loading")}</p> });
const NewJobDialog = dynamic(() => import("./NewJobDialog"), { ssr: false });
// M6.5: only jobs waiting on a usage limit need it; rendered on the server too (no shift).
const LimitPanel = dynamic(() => import("./LimitPanel").then((m) => m.LimitPanel));

type Tab = "timeline" | "log" | "plan" | "diff" | "result";

const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Live job stream (SSE through /api/jobs/[id]/events). EventSource reconnects by itself and sends
 * Last-Event-ID, so the log resumes at the byte offset it reached; snapshots replace the job. */
function useJobStream(id: number, active: boolean, onJob: (j: Partial<JobView>) => void) {
  const [log, setLog] = React.useState<LogBuffer>(emptyLog);
  const [state, setState] = React.useState<"idle" | "open" | "reconnecting" | "ended">("idle");
  const onJobRef = React.useRef(onJob);
  React.useEffect(() => {
    onJobRef.current = onJob;
  });
  React.useEffect(() => {
    if (!active) return;
    const es = new EventSource(`/api/jobs/${id}/events`);
    es.addEventListener("open", () => setState("open"));
    es.addEventListener("error", () => setState((s) => (s === "ended" ? s : "reconnecting")));
    es.addEventListener("job", (e) => onJobRef.current(JSON.parse((e as MessageEvent).data) as Partial<JobView>));
    es.addEventListener("log", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { run: string; stream: string | null; chunk: string | null };
      setLog((b) => appendLog(b, d.run, [d]));
    });
    es.addEventListener("end", (e) => {
      setState("ended");
      es.close();
      onJobRef.current(JSON.parse((e as MessageEvent).data) as Partial<JobView>);
    });
    return () => es.close();
  }, [id, active]);
  return { log, state };
}

export function JobDetail({ initial, paperclipUi, initialDiff = null }: { initial: JobView; paperclipUi: string; initialDiff?: JobDiff | null }) {
  const router = useRouter();
  const { push } = useToast();
  const [job, setJob] = React.useState(initial);
  // A job waiting on a usage limit (M6.5) runs nothing: its timeline says what happened.
  const firstTab = (j: JobView): Tab =>
    j.status === "waiting_reset" || j.gate === "limit"
      ? "timeline"
      : j.status === "needs_approval"
        ? j.gate === "diff"
          ? "diff"
          : j.gate === "plan"
            ? "plan"
            : "result"
        : isActive(j.status)
          ? "log"
          : "timeline";
  const [tab, setTab] = React.useState<Tab>(() => firstTab(initial));
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "approve" | "reject" | "stop">(null);
  const [error, setError] = React.useState<{ code?: string; detail?: string | null; text?: string } | null>(null);
  const [note, setNote] = React.useState("");
  const [again, setAgain] = React.useState(false);
  const ids = React.useId();

  // The server's view (with the timeline) wins whenever a refresh brings a new one.
  const [seenInitial, setSeenInitial] = React.useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setJob(initial);
  }

  const stamp = React.useRef(`${initial.status}:${initial.gate}:${initial.run_id}`);
  const picked = React.useRef(false); // you chose a tab: live updates no longer switch it
  const { log, state } = useJobStream(initial.id, isActive(initial.status), (snap) => {
    setJob((j) => ({ ...j, ...snap, project: j.project, events: j.events }));
    const s = `${snap.status}:${snap.gate}:${snap.run_id}`;
    if (snap.status && s !== stamp.current) {
      stamp.current = s;
      // The job now waits for you: show what to decide on (unless you picked a tab yourself).
      if (snap.status === "needs_approval" && snap.gate && snap.gate !== "limit" && !picked.current) setTab(snap.gate === "diff" ? "diff" : snap.gate === "plan" ? "plan" : "result");
      router.refresh(); // fresh timeline and approval deadline from the server
    }
  });

  const act = async (kind: "approve" | "reject" | "stop") => {
    setBusy(kind);
    setError(null);
    const r = kind === "approve" ? await approveJob(job.id, note) : kind === "reject" ? await rejectJob(job.id, note) : await stopJob(job.id);
    setBusy(null);
    setConfirmStop(false);
    if (!r.ok) return setError({ code: r.code ?? "error", detail: r.detail ?? r.error, text: r.error });
    setNote("");
    setJob((j) => ({ ...r.data, project: r.data.project ?? j.project, events: j.events }));
    push({ tone: kind === "approve" ? "success" : "info", title: kind === "approve" ? tJobs("decide.approved") : kind === "reject" ? tJobs("decide.rejected") : tJobs("status.stopped") });
    if (kind === "approve" && job.gate === "plan") setTab("log");
    router.refresh();
  };

  const cost = costSummary(job);
  const pct = budgetPct(job);
  const level = jobsStrings.autonomy.names[job.autonomy] ?? String(job.autonomy);
  const hasDiff = !!job.worktree && (job.gate === "diff" || job.status === "done" || (job.status === "running" && job.phase === "edit"));
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "timeline", label: tJobs("detail.tabs.timeline"), show: true },
    { id: "log", label: tJobs("detail.tabs.log"), show: true },
    { id: "plan", label: tJobs("detail.tabs.plan"), show: !!job.plan },
    { id: "diff", label: tJobs("detail.tabs.diff"), show: hasDiff || job.gate === "diff" },
    { id: "result", label: tJobs("detail.tabs.result"), show: !!job.result && job.status !== "needs_approval" },
  ];
  const visible = tabs.filter((t) => t.show);
  const current = visible.some((t) => t.id === tab) ? tab : "timeline";

  const onTabKey = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = visible.findIndex((t) => t.id === current);
    const nxt = visible[(i + d + visible.length) % visible.length];
    picked.current = true;
    setTab(nxt.id);
    requestAnimationFrame(() => document.getElementById(`${ids}-tab-${nxt.id}`)?.focus());
  };

  const limited = job.status === "waiting_reset" || (job.status === "needs_approval" && job.gate === "limit");
  const waiting = job.status === "needs_approval" && job.gate && job.gate !== "limit";

  return (
    <article className="grid gap-6" aria-labelledby={`${ids}-h`}>
      <header className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-2">
            <p className="font-mono text-sm text-ink-muted">#{job.id}</p>
            <h1 id={`${ids}-h`} className="heading max-w-4xl break-words">
              {job.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {job.paid && <span className="rounded-chip bg-warn/15 px-2 text-[0.75rem] font-semibold text-warn">{tSubs("job.paidBadge")}</span>}
            <StatusBadge
              status={badgeOf(job.status)}
              label={job.status === "needs_approval" && job.gate ? tJobs(`gate.${job.gate}`) : tJobs(`status.${job.status}`)}
            />
            {isActive(job.status) && !limited &&
              (confirmStop ? null : (
                <Button type="button" size="sm" variant="glass" onClick={() => setConfirmStop(true)}>
                  <Square aria-hidden className="size-3.5" /> {tJobs("detail.stop")}
                </Button>
              ))}
            {!isActive(job.status) && job.project && (
              <Button type="button" size="sm" variant="glass" onClick={() => setAgain(true)}>
                {tJobs("detail.runAgain")}
              </Button>
            )}
          </div>
        </div>
        {confirmStop && (
          <div role="alertdialog" aria-labelledby={`${ids}-stop`} className="surface-strong flex flex-wrap items-center gap-3 rounded-panel p-3">
            <p id={`${ids}-stop`} className="min-w-0 flex-1 text-sm">
              {tJobs("detail.stopConfirm")}
            </p>
            <Button type="button" size="sm" variant="danger" loading={busy === "stop"} onClick={() => act("stop")}>
              {tJobs("detail.stopYes")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
              {tJobs("detail.keep")}
            </Button>
          </div>
        )}
        {job.error && (
          <p role={job.status === "failed" ? "alert" : undefined} className={cn("rounded-control border p-3 text-sm", job.status === "failed" ? "border-err text-err" : "border-hairline text-ink-muted")}>
            <span className="font-semibold">{tJobs("detail.error")}: </span>
            {job.error}
          </p>
        )}
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-6">
          {limited && <LimitPanel job={job} onJob={(j) => setJob((cur) => ({ ...j, project: j.project ?? cur.project, events: cur.events }))} />}
          {waiting && (
            <GlassPanel as="section" tone="strong" aria-labelledby={`${ids}-gate`} className="grid gap-3 border border-warn/40">
              <h2 id={`${ids}-gate`} className="font-display text-xl font-bold tracking-tight">
                {tJobs(`gate.${job.gate!}`)}
              </h2>
              <p className="text-sm text-ink-muted">
                {job.gate === "plan"
                  ? tJobs("decide.planLead", { agent: job.agent_label })
                  : job.gate === "diff"
                    ? tJobs("decide.diffLead", { branch: job.branch ?? "" })
                    : tJobs("decide.resultLead", { agent: job.agent_label })}
              </p>
              {job.approval_expires_at && (
                <p className="text-[0.8125rem] text-ink-muted" suppressHydrationWarning>
                  {tJobs("detail.expires", { time: timeFmt.format(new Date(job.approval_expires_at)) })}
                </p>
              )}
              <label htmlFor={`${ids}-note`} className="text-sm font-semibold">
                {tJobs("decide.note")}
              </label>
              <textarea
                id={`${ids}-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder={tJobs("decide.notePlaceholder")}
                className="min-h-16 w-full rounded-control border border-hairline bg-glass-strong p-3 text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" loading={busy === "approve"} disabled={!!busy} onClick={() => act("approve")}>
                  <Check aria-hidden className="size-4" />
                  {job.gate === "plan" ? tJobs("decide.approvePlan") : job.gate === "diff" ? tJobs("decide.approveDiff") : tJobs("decide.approveResult")}
                </Button>
                <Button type="button" size="sm" variant="danger" loading={busy === "reject"} disabled={!!busy} onClick={() => act("reject")}>
                  <X aria-hidden className="size-4" /> {tJobs("decide.reject")}
                </Button>
              </div>
            </GlassPanel>
          )}
          {error && <ErrorNote live code={error.code} detail={error.detail} />}

          <section aria-label={tJobs("detail.tabs.label")} className="grid gap-3">
            <div role="tablist" aria-label={tJobs("detail.tabs.label")} onKeyDown={onTabKey} className="surface-strong flex w-fit max-w-full flex-wrap gap-0.5 rounded-chip p-1">
              {visible.map((t) => (
                <button
                  key={t.id}
                  id={`${ids}-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={current === t.id}
                  aria-controls={`${ids}-panel`}
                  tabIndex={current === t.id ? 0 : -1}
                  onClick={() => {
                    picked.current = true;
                    setTab(t.id);
                  }}
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-chip px-3.5 text-sm",
                    current === t.id ? "bg-pill-active font-bold text-ink ring-1 ring-accent-strong/30" : "font-medium text-ink-muted hover:text-ink",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${current}`} tabIndex={0} className="min-w-0">
              {current === "timeline" && <JobTimeline job={job} />}
              {current === "log" && <JobLog job={job} live={log} state={state} />}
              {current === "plan" && job.plan && (
                <GlassPanel tone="strong" className="min-w-0 text-[0.9375rem] leading-relaxed break-words">
                  <Markdown text={job.plan} />
                </GlassPanel>
              )}
              {current === "result" && job.result && (
                <GlassPanel tone="strong" className="min-w-0 text-[0.9375rem] leading-relaxed break-words">
                  <Markdown text={job.result} />
                </GlassPanel>
              )}
              {current === "diff" &&
                (job.worktree ? (
                  <DiffView jobId={job.id} initial={initialDiff} />
                ) : (
                  <GlassPanel tone="strong">
                    <p className="text-sm text-ink-muted">{tJobs("detail.noWorktree", { branch: job.branch ?? "" })}</p>
                  </GlassPanel>
                ))}
            </div>
          </section>
        </div>

        <aside className="grid gap-4" aria-label={tJobs("detail.tabs.label")}>
          <GlassPanel tone="strong" className="grid gap-3 text-sm">
            <dl className="grid gap-2.5">
              <div className="grid gap-0.5">
                <dt className="label">{tJobs("detail.agent")}</dt>
                <dd className="flex items-center gap-1.5 font-semibold">
                  <Bot aria-hidden className="size-4 text-ink-muted" /> {job.agent_label}
                </dd>
              </div>
              {job.project && (
                <div className="grid gap-0.5">
                  <dt className="label">{tJobs("detail.project")}</dt>
                  <dd className="flex min-w-0 items-center gap-1.5">
                    <FolderGit2 aria-hidden className="size-4 shrink-0 text-ink-muted" />
                    <span className="truncate font-semibold" data-tip-truncated={job.project.path}>
                      {job.project.name}
                    </span>
                  </dd>
                </div>
              )}
              <div className="grid gap-0.5">
                <dt className="label">{tJobs("detail.autonomy")}</dt>
                <dd>
                  <span className="font-semibold">{job.autonomy}</span> · {level}
                </dd>
              </div>
              {job.branch && (
                <div className="grid gap-1">
                  <dt className="label">{tJobs("detail.branch")}</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-2">
                    <code className="solid-panel inline-flex min-w-0 items-center gap-1 px-2 py-1 font-mono text-[0.8125rem] break-all">
                      <GitBranch aria-hidden className="size-3.5 shrink-0" />
                      {job.branch}
                    </code>
                    <CopyButton text={job.branch} label={tJobs("detail.copyBranch")} />
                  </dd>
                </div>
              )}
              <div className="grid gap-0.5">
                <dt className="label">{tJobs("cost.budget")}</dt>
                <dd className="flex items-center gap-3">
                  <Dial value={pct} label={tJobs("cost.budget")} valueText={tJobs("cost.budgetText", { used: usd(job.list_price_usd), budget: usd(job.budget_list_usd) })} size={64}>
                    <Gauge aria-hidden className="size-4 text-ink-muted" />
                  </Dial>
                  <span className="grid gap-0.5 tabular-nums">
                    {cost.kind === "unreported" ? (
                      <>
                        <span className="font-semibold">{tJobs("cost.notReported")}</span>
                        <span className="text-[0.8125rem] text-ink-muted">{tJobs("cost.notReportedHelp", { agent: job.agent_label, turns: job.turns })}</span>
                      </>
                    ) : (
                      <>
                        <span className="font-semibold">{tJobs("cost.budgetText", { used: cost.listed, budget: usd(job.budget_list_usd) })}</span>
                        <span className="text-[0.8125rem] text-ink-muted">{cost.kind === "free" ? tJobs("cost.free") : tJobs("cost.spent", { amount: cost.spent })}</span>
                      </>
                    )}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="flex flex-wrap gap-x-3 text-[0.8125rem] text-ink-muted">
              <span>{tJobs("detail.turns", { n: job.turns })}</span>
              {job.started_at && job.finished_at && <span>{tJobs("detail.elapsed", { time: duration(job.started_at, job.finished_at) })}</span>}
            </p>
            <p className="text-[0.8125rem] text-ink-muted">{tJobs("cost.subscription")}</p>
            {job.paperclip.issue_id && (
              <a
                href={`${paperclipUi}/issues/${encodeURIComponent(job.paperclip.issue_id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-accent-strong underline underline-offset-4"
              >
                {tJobs("detail.paperclip")} <ExternalLink aria-hidden className="size-3.5" />
              </a>
            )}
          </GlassPanel>
          {job.branch && <MergeHelp job={job} />}
          <GlassPanel tone="strong" className="grid gap-1.5 text-sm">
            <h2 className="label">{tJobs("detail.task")}</h2>
            <p className="max-h-48 overflow-y-auto break-words whitespace-pre-wrap">{job.prompt}</p>
            {job.attachments && job.attachments.length > 0 && <MessageAttachments files={job.attachments} />}
          </GlassPanel>
        </aside>
      </div>
      {again && job.project && (
        <NewJobDialog
          open
          onOpenChange={setAgain}
          initialPrompt={job.prompt}
          initialProject={job.project.id}
          initialAgents={job.agent_chain}
          initialAutonomy={job.autonomy}
        />
      )}
    </article>
  );
}
