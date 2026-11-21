"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Hourglass, Shuffle, Square, Wallet } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { loadJobChoices, loadOverflow, rerouteJob, stopJob, choosePaidOverflow, waitForReset } from "@/app/jobs/actions";
import { usd } from "@/lib/job-format";
import { resetTime } from "@/lib/subscription-format";
import type { AgentRow, JobView, OverflowSettings } from "@/lib/router-types";
import { tJobs } from "@/i18n/jobs";
import { tSubs } from "@/i18n/subscriptions";

/**
 * A job waiting on a subscription usage limit (M6.5, ADR 0014): when it resumes, and what you can do
 * instead. `far` = the reset is more than `max_auto_wait_h` away, so the job asks before waiting (Needs you).
 * "Run on another agent" only offers other providers: Switchboard never switches accounts of one provider.
 */
export function LimitPanel({ job, onJob, maxWaitH = 12 }: { job: JobView; onJob: (j: JobView) => void; maxWaitH?: number }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const far = job.status === "needs_approval" && job.gate === "limit";
  const at = resetTime(job.resume_at);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{ code: string; detail: string | null } | null>(null);
  const [mode, setMode] = React.useState<null | "another" | "paid" | "cancel">(null);
  const [agents, setAgents] = React.useState<AgentRow[] | null>(null);
  const [pick, setPick] = React.useState("");
  const [overflow, setOverflow] = React.useState<OverflowSettings | null>(null);
  const [budget, setBudget] = React.useState("1.00");

  const current = agents?.find((a) => a.id === job.agent);
  const others = (agents ?? []).filter((a) => a.runnable && !a.paid && !a.paused && a.cli !== (current?.cli ?? job.agent));

  const done = (r: { ok: true; data: JobView } | { ok: false; error: string; code?: string; detail?: string | null }, title: string) => {
    setBusy(null);
    if (!r.ok) return setError({ code: r.code ?? "error", detail: r.detail ?? r.error });
    onJob(r.data);
    setMode(null);
    push({ tone: "success", title });
    router.refresh();
  };

  const openAnother = async () => {
    setMode("another");
    if (agents) return;
    const r = await loadJobChoices();
    if (r.ok) {
      setAgents(r.data.agents.agents);
      const first = r.data.agents.agents.find((a) => a.runnable && !a.paid && !a.paused && a.cli !== r.data.agents.agents.find((x) => x.id === job.agent)?.cli);
      setPick(first?.id ?? "");
    } else setError({ code: r.code ?? "error", detail: r.detail ?? r.error });
  };
  const openPaid = async () => {
    setMode("paid");
    if (overflow) return;
    const r = await loadOverflow();
    if (r.ok) {
      setOverflow(r.data);
      if (r.data.left_usd != null) setBudget(Math.min(1, r.data.left_usd).toFixed(2));
    } else setError({ code: r.code ?? "error", detail: r.detail ?? r.error });
  };
  const amount = Number(budget.replace(/^\$/, ""));

  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={`${ids}-h`} className="grid gap-3 border border-warn/40" data-testid="limit-panel">
      <h2 id={`${ids}-h`} className="flex items-center gap-2 font-display text-xl font-bold tracking-tight">
        <Hourglass aria-hidden className="size-5 text-warn" />
        {far ? tSubs("job.farTitle") : tSubs("job.waitingTitle")}
      </h2>
      {!far && at && <p className="text-lg font-semibold tabular-nums" suppressHydrationWarning>{tSubs("job.resumesAt", { at })}</p>}
      <p className="text-sm text-ink-muted" suppressHydrationWarning>
        {far ? tSubs("job.farBody", { agent: job.agent_label, at, hours: maxWaitH }) : tSubs("job.resumesBody", { agent: job.agent_label })}
      </p>
      {(job.attempt ?? 0) > 0 && <p className="text-[0.8125rem] text-ink-muted">{tSubs("job.attempt", { n: (job.attempt ?? 0) + 1 })}</p>}

      <div className="flex flex-wrap gap-2">
        {far && (
          <Button type="button" size="sm" loading={busy === "wait"} disabled={!!busy} onClick={async () => { setBusy("wait"); done(await waitForReset(job.id), tSubs("job.resumesAt", { at })); }}>
            <Hourglass aria-hidden className="size-4" /> {tSubs("job.waitAnyway")}
          </Button>
        )}
        <Button type="button" size="sm" variant="glass" disabled={!!busy} aria-expanded={mode === "another"} onClick={openAnother}>
          <Shuffle aria-hidden className="size-4" /> {tSubs("job.another")}
        </Button>
        <Button type="button" size="sm" variant="glass" disabled={!!busy} aria-expanded={mode === "paid"} onClick={openPaid}>
          <Wallet aria-hidden className="size-4" /> {tSubs("job.paid")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => setMode("cancel")}>
          <Square aria-hidden className="size-3.5" /> {tSubs("job.cancel")}
        </Button>
      </div>

      {mode === "another" && (
        <div className="grid gap-2 rounded-control border border-hairline p-3 text-sm">
          <label htmlFor={`${ids}-agent`} className="font-semibold">
            {tSubs("job.anotherPick")}
          </label>
          {agents === null ? (
            <p className="text-ink-muted">{tJobs("diff.loading")}</p>
          ) : others.length ? (
            <select id={`${ids}-agent`} value={pick} onChange={(e) => setPick(e.target.value)} aria-describedby={`${ids}-ah`} className="min-h-(--ctl) w-60 rounded-control border border-hairline bg-glass-strong px-3">
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-ink-muted">—</p>
          )}
          <p id={`${ids}-ah`} className="text-[0.8125rem] text-ink-muted">
            {tSubs("job.anotherHelp")}
          </p>
          <div>
            <Button type="button" size="sm" disabled={!pick || !!busy} loading={busy === "another"} onClick={async () => { setBusy("another"); const label = others.find((a) => a.id === pick)?.label ?? pick; done(await rerouteJob(job.id, pick), tSubs("job.useAgent", { agent: label })); }}>
              {tSubs("job.useAgent", { agent: others.find((a) => a.id === pick)?.label ?? "…" })}
            </Button>
          </div>
        </div>
      )}

      {mode === "paid" && (
        <div role="group" aria-labelledby={`${ids}-paid`} className="grid gap-2 rounded-control border border-warn/40 p-3 text-sm">
          <p id={`${ids}-paid`} className="font-semibold text-warn">
            {tSubs("job.paidConfirm", { budget: usd(Number.isFinite(amount) ? amount : 0) })}
          </p>
          {overflow === null ? (
            <p className="text-ink-muted">{tJobs("diff.loading")}</p>
          ) : !overflow.ready ? (
            <p className="text-ink-muted">{tSubs("job.paidOff")}</p>
          ) : (
            <>
              <p className="text-ink-muted">{tSubs("job.paidBody", { model: overflow.model ?? "", budget: usd(Number.isFinite(amount) ? amount : 0), left: usd(overflow.left_usd ?? 0) })}</p>
              {overflow.test_free_model && <p className="text-[0.8125rem] text-ink-muted">{tSubs("overflow.testMode")}</p>}
              <label htmlFor={`${ids}-budget`} className="font-semibold">
                {tSubs("job.paidBudget")}
              </label>
              <input id={`${ids}-budget`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} className="min-h-(--ctl) w-32 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums" />
              <div>
                <Button type="button" size="sm" variant="danger" disabled={!(amount > 0) || !!busy} loading={busy === "paid"} onClick={async () => { setBusy("paid"); done(await choosePaidOverflow(job.id, amount), tSubs("job.paidBadge")); }}>
                  <Wallet aria-hidden className="size-4" /> {tSubs("job.paidConfirm", { budget: usd(Number.isFinite(amount) ? amount : 0) })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "cancel" && (
        <div role="alertdialog" aria-labelledby={`${ids}-c`} className="flex flex-wrap items-center gap-3 rounded-control border border-hairline p-3 text-sm">
          <p id={`${ids}-c`} className="min-w-0 flex-1">
            {tJobs("detail.stopConfirm")}
          </p>
          <Button type="button" size="sm" variant="danger" loading={busy === "cancel"} onClick={async () => { setBusy("cancel"); done(await stopJob(job.id), tJobs("status.stopped")); }}>
            {tJobs("detail.stopYes")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
            {tJobs("detail.keep")}
          </Button>
        </div>
      )}
      {error && <ErrorNote live code={error.code} detail={error.detail} />}
    </GlassPanel>
  );
}
