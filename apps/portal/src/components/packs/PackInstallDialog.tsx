"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink, ShieldAlert, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { Skeleton, LoadingLabel } from "@/components/kit/Skeleton";
import { InstallProgress, type InstallPhase } from "@/components/connections/InstallProgress";
import { packInstallPlan, packInstallRun, packsRefresh } from "@/app/connections/pack-actions";
import type { LogEntry } from "@/lib/router-types";
import type { PackJob, PackPlan, PackRow } from "@/lib/packs-types";
import { tPacks } from "@/i18n/packs";

type Phase = "planning" | "review" | "starting" | "plan-error" | InstallPhase;

/**
 * Pack install (M4.5a, ADR 0018): 1) read the plan (exact package, version, hashes, commands, where files go;
 * nothing runs yet), 2) confirm (twice for an unverified pack), 3) watch the log. hostprobe runs only what the
 * pack's committed lock says.
 */
export default function PackInstallDialog({ pack, onClose }: { pack: PackRow; onClose: () => void }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [phase, setPhase] = React.useState<Phase>("planning");
  const [plan, setPlan] = React.useState<PackPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [job, setJob] = React.useState<PackJob | null>(null);
  const [accept, setAccept] = React.useState(false);
  const [reconnecting, setReconnecting] = React.useState(false);
  const planned = React.useRef(false);

  const loadPlan = React.useCallback(async () => {
    setPhase("planning");
    setError(null);
    const r = await packInstallPlan(pack.id);
    if (r.ok) {
      setPlan(r.data);
      setPhase("review");
    } else {
      setError(r.error);
      setPhase("plan-error");
    }
  }, [pack.id]);

  React.useEffect(() => {
    if (planned.current) return;
    planned.current = true;
    void loadPlan();
  }, [loadPlan]);

  React.useEffect(() => {
    if (!job) return;
    const es = new EventSource(`/api/packs/${job.id}/events`);
    es.addEventListener("log", (e) => {
      setReconnecting(false);
      setEntries((prev) => [...prev, JSON.parse((e as MessageEvent).data) as LogEntry]);
    });
    es.addEventListener("exit", async (e) => {
      es.close();
      const { state } = JSON.parse((e as MessageEvent).data) as { state: InstallPhase };
      setPhase(state);
      if (state === "ok") {
        await packsRefresh();
        router.refresh();
        push({ tone: "success", title: tPacks("install.done", { name: pack.name }), body: tPacks("install.doneNext") });
      } else setError(tPacks("install.failed"));
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setPhase("failed");
        setError(tPacks("install.failed"));
      } else setReconnecting(true);
    };
    return () => es.close();
  }, [job, pack.name, push, router]);

  const confirm = async () => {
    if (!plan?.plan_id) return;
    setPhase("starting");
    const r = await packInstallRun(pack.id, plan.plan_id, accept);
    if (!r.ok) {
      setError(r.error);
      setPhase("plan-error");
      return;
    }
    setEntries([]);
    setJob(r.data);
    setPhase("running");
  };

  const running = phase === "running" || phase === "starting";
  const finished = phase === "ok" || phase === "failed" || phase === "cancelled" || phase === "timeout";
  const canConfirm = !!plan?.plan_id && !plan.problem && (!plan.unverified || accept);

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent closable={!running} onEscapeKeyDown={(e) => running && e.preventDefault()} onInteractOutside={(e) => running && e.preventDefault()}>
        <DialogTitle className="heading pr-8 text-2xl!">{tPacks("install.title", { name: pack.name })}</DialogTitle>
        <DialogDescription className="text-ink-muted">
          {phase === "review" ? tPacks("install.reviewBody") : phase === "planning" ? tPacks("install.planning") : tPacks("install.log")}
        </DialogDescription>

        {phase === "planning" && (
          <div aria-busy className="grid gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <LoadingLabel />
          </div>
        )}

        {phase === "plan-error" && (
          <div role="alert" className="grid gap-3">
            <p className="flex items-start gap-1.5 text-err">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="font-semibold">{tPacks("install.planFailed")}: </span>
                {error}
              </span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={loadPlan}>
                {tPacks("install.retry")}
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {tPacks("install.close")}
              </Button>
            </div>
          </div>
        )}

        {plan && phase === "review" && (
          <div className="grid gap-4">
            {plan.current && plan.current !== plan.version && <p className="text-sm">{tPacks("install.update", { current: plan.current })}</p>}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="label">{tPacks("install.source")}</dt>
                <dd className="break-all">
                  <a href={plan.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent-strong underline underline-offset-2">
                    {plan.source}
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  </a>
                </dd>
              </div>
              <div>
                <dt className="label">{tPacks("install.package")}</dt>
                <dd className="font-mono break-all">{plan.package}</dd>
              </div>
              <div>
                <dt className="label">{tPacks("install.version")}</dt>
                <dd className="font-mono">{plan.version}</dd>
              </div>
              <div>
                <dt className="label">{tPacks("install.deps")}</dt>
                <dd>{tPacks("install.depsValue", { n: plan.dependencies })}</dd>
              </div>
              {plan.hash && (
                <div className="sm:col-span-2">
                  <dt className="label">{tPacks("install.hash")}</dt>
                  <dd className="font-mono text-xs break-all">{plan.hash}</dd>
                </div>
              )}
            </dl>
            {plan.lookalikes.length > 0 && (
              <p role="note" className="text-sm text-ink-muted">
                {tPacks("install.lookalike", { names: plan.lookalikes.join(", ") })}
              </p>
            )}

            <section aria-labelledby={`${ids}-cmd`} className="grid gap-1.5">
              <h3 id={`${ids}-cmd`} className="label">
                {tPacks("install.commands")}
              </h3>
              <pre className="solid-panel overflow-x-auto p-3 text-xs" tabIndex={0} aria-label={tPacks("install.commands")}>
                {plan.commands.map((c) => `$ ${c}`).join("\n")}
              </pre>
              {plan.install_scripts.length > 0 && <p className="text-xs text-ink-muted">{tPacks("install.scripts", { n: plan.install_scripts.length })}</p>}
            </section>

            <section aria-labelledby={`${ids}-w`} className="grid gap-1.5 text-sm">
              <h3 id={`${ids}-w`} className="label">
                {tPacks("install.writes")}
              </h3>
              <ul className="grid list-disc gap-1 pl-5">
                {plan.writes.map((w) => (
                  <li key={w} className="font-mono text-xs break-all">
                    {w}
                  </li>
                ))}
              </ul>
              {plan.project_writes.length > 0 && (
                <>
                  <p className="text-ink-muted">{tPacks("install.projectWrites")}</p>
                  <p className="font-mono text-xs break-all">{plan.project_writes.join(", ")}</p>
                </>
              )}
              {plan.artifacts.length > 0 && (
                <>
                  <p className="text-ink-muted">{tPacks("install.artifacts")}</p>
                  <p className="font-mono text-xs break-all">{plan.artifacts.join(", ")}</p>
                </>
              )}
            </section>

            {plan.requires.length > 0 && (
              <section aria-labelledby={`${ids}-r`} className="grid gap-1 text-sm">
                <h3 id={`${ids}-r`} className="label">
                  {tPacks("install.requires")}
                </h3>
                {plan.requires.map((r) => (
                  <p key={r.name} className={r.ok ? undefined : "text-err"}>
                    {r.found ? tPacks("install.requireFound", { name: r.name, need: r.need, found: r.found }) : tPacks("install.requireMissing", { name: r.name, need: r.need })}
                  </p>
                ))}
              </section>
            )}

            {plan.problem ? (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-err">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-semibold">{tPacks("install.problem")}: </span>
                  {plan.problem}
                </span>
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ok">
                <ShieldCheck aria-hidden className="size-4 shrink-0" />
                {tPacks("install.noSudo")}
              </p>
            )}

            {plan.unverified && !plan.problem && (
              <div className="grid gap-2 rounded-control border border-warn p-3 text-sm" role="group" aria-labelledby={`${ids}-u`}>
                <p id={`${ids}-u`} className="flex items-center gap-1.5 font-semibold">
                  <ShieldAlert aria-hidden className="size-4 text-warn" /> {tPacks("install.unverifiedTitle")}
                </p>
                <p className="text-ink-muted">{tPacks("install.unverifiedBody")}</p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="size-4" />
                  {tPacks("install.accept")}
                </label>
              </div>
            )}
            {plan.expires_in ? <p className="text-xs text-ink-muted">{tPacks("install.expires", { minutes: Math.round(plan.expires_in / 60) })}</p> : null}

            <div className="flex flex-wrap gap-2">
              <Button onClick={confirm} disabled={!canConfirm}>
                {tPacks("install.confirm", { name: pack.name })}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {tPacks("install.cancel")}
              </Button>
            </div>
          </div>
        )}

        {(running || finished) && plan && (
          <div className="grid gap-4">
            <InstallProgress
              name={pack.name}
              version={plan.version}
              phase={running ? "running" : (phase as InstallPhase)}
              entries={entries}
              error={phase === "failed" ? error : null}
              reconnecting={reconnecting}
            />
            {!running && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={onClose}>
                  {phase === "ok" ? tPacks("install.doneButton") : tPacks("install.close")}
                </Button>
                {phase !== "ok" && (
                  <Button size="sm" variant="ghost" onClick={loadPlan}>
                    {tPacks("install.retry")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
