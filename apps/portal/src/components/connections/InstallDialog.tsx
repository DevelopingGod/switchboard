"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { Skeleton, LoadingLabel } from "@/components/kit/Skeleton";
import { cliCheck, cliInstallCancel, cliInstallPlan, cliInstallRun } from "@/app/connections/actions";
import type { InstallJob, InstallPlan } from "@/lib/router-types";
import { t } from "@/i18n/strings";

type Phase = "planning" | "review" | "starting" | "running" | "ok" | "failed" | "cancelled" | "timeout" | "plan-error";

/**
 * Install flow: 1) read the exact plan (nothing runs yet), 2) confirm, 3) watch the streamed log.
 * The plan is fetched through a server action; the log arrives over SSE from our own origin.
 */
export default function InstallDialog({ provider, name, onClose }: { provider: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const { push } = useToast();
  const [phase, setPhase] = React.useState<Phase>("planning");
  const [plan, setPlan] = React.useState<InstallPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<string[]>([]);
  const [job, setJob] = React.useState<InstallJob | null>(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const planned = React.useRef(false);
  const logRef = React.useRef<HTMLPreElement>(null);

  const loadPlan = React.useCallback(async () => {
    setPhase("planning");
    setError(null);
    const r = await cliInstallPlan(provider);
    if (r.ok) {
      setPlan(r.data);
      setPhase("review");
    } else {
      setError(r.error);
      setPhase("plan-error");
    }
  }, [provider]);

  React.useEffect(() => {
    if (planned.current) return;
    planned.current = true;
    void loadPlan();
  }, [loadPlan]);

  React.useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  React.useEffect(() => {
    if (!job) return;
    const es = new EventSource(`/api/install/${job.id}/events`);
    es.addEventListener("log", (e) => {
      setReconnecting(false);
      setLines((prev) => [...prev, JSON.parse((e as MessageEvent).data) as string]);
    });
    es.addEventListener("exit", async (e) => {
      es.close();
      const { state } = JSON.parse((e as MessageEvent).data) as { state: Phase };
      setPhase(state);
      if (state === "ok") {
        await cliCheck();
        router.refresh();
        push({ tone: "success", title: t("install.done", { name }), body: t("install.doneNext") });
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setPhase("failed");
        setError(t("install.failed"));
      } else setReconnecting(true);
    };
    return () => es.close();
  }, [job, name, push, router]);

  const confirm = async () => {
    if (!plan) return;
    setPhase("starting");
    const r = await cliInstallRun(provider, plan.plan_id);
    if (!r.ok) {
      setError(r.error);
      setPhase("plan-error");
      return;
    }
    setLines([]);
    setJob(r.data);
    setPhase("running");
  };

  const running = phase === "running" || phase === "starting";

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent closable={!running} onEscapeKeyDown={(e) => running && e.preventDefault()} onInteractOutside={(e) => running && e.preventDefault()}>
        <DialogTitle className="heading pr-8 text-2xl!">{t("install.title", { name })}</DialogTitle>
        <DialogDescription className="text-ink-muted">
          {phase === "review" ? t("install.reviewBody") : phase === "planning" ? t("install.planning") : t("install.log")}
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
                <span className="font-semibold">{t("install.planFailed")}: </span>
                {error}
              </span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={loadPlan}>
                {t("install.retry")}
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("install.close")}
              </Button>
            </div>
          </div>
        )}

        {plan && phase === "review" && (
          <div className="grid gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="label">{t("install.source")}</dt>
                <dd className="break-all">
                  <a href={plan.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent-strong underline underline-offset-2">
                    {plan.source}
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  </a>
                </dd>
              </div>
              <div>
                <dt className="label">{t("install.docs")}</dt>
                <dd className="break-all">
                  <a href={plan.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent-strong underline underline-offset-2">
                    {plan.docs}
                    <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                  </a>
                </dd>
              </div>
              <div>
                <dt className="label">{t("install.version")}</dt>
                <dd className="font-mono">{plan.version}</dd>
              </div>
              {plan.sha256 && (
                <div>
                  <dt className="label">{t("install.checksum")}</dt>
                  <dd className="font-mono text-xs break-all">{plan.sha256}</dd>
                </div>
              )}
            </dl>

            <section aria-labelledby="install-commands" className="grid gap-1.5">
              <h4 id="install-commands" className="label">
                {t("install.commands")}
              </h4>
              <pre className="solid-panel overflow-x-auto p-3" tabIndex={0} aria-label={t("install.commands")}>
                {plan.commands.map((c) => `$ ${c}`).join("\n")}
              </pre>
            </section>

            <section aria-labelledby="install-effects" className="grid gap-1.5">
              <h4 id="install-effects" className="label">
                {t("install.effects")}
              </h4>
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {plan.effects.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </section>

            <p className="flex items-center gap-1.5 text-sm font-semibold text-ok">
              <ShieldCheck aria-hidden className="size-4" />
              {t("install.noSudo")}
            </p>
            <p className="text-xs text-ink-muted">{t("install.expires", { minutes: Math.round(plan.expires_in / 60) })}</p>

            <div className="flex flex-wrap gap-2">
              <Button onClick={confirm}>{t("install.confirm", { name })}</Button>
              <Button variant="ghost" onClick={onClose}>
                {t("install.cancel")}
              </Button>
            </div>
          </div>
        )}

        {(running || phase === "ok" || phase === "failed" || phase === "cancelled" || phase === "timeout") && (
          <div className="grid gap-3">
            <pre
              ref={logRef}
              role="log"
              aria-live="polite"
              aria-label={t("install.log")}
              tabIndex={0}
              className="solid-panel max-h-64 min-h-32 overflow-auto p-3 whitespace-pre-wrap"
            >
              {lines.length ? lines.join("\n") : t("install.running")}
            </pre>
            {reconnecting && <p className="text-sm text-ink-muted">{t("install.reconnecting")}</p>}
            <p role="status" className="flex items-center gap-1.5 text-sm font-semibold">
              {phase === "ok" && (
                <span className="flex items-center gap-1.5 text-ok">
                  <CheckCircle2 aria-hidden className="size-4" />
                  {t("install.done", { name })} {t("install.doneNext")}
                </span>
              )}
              {phase === "failed" && <span className="text-err">{error ?? t("install.failed")}</span>}
              {phase === "cancelled" && <span className="text-ink-muted">{t("install.cancelled")}</span>}
              {phase === "timeout" && <span className="text-err">{t("install.timedOut")}</span>}
            </p>
            <div className="flex gap-2">
              {running ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={!job}
                  onClick={() => job && void cliInstallCancel(job.id)}
                >
                  {t("install.stop")}
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={onClose}>
                    {t("install.close")}
                  </Button>
                  {phase !== "ok" && (
                    <Button size="sm" variant="ghost" onClick={loadPlan}>
                      {t("install.retry")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
