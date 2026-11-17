"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { Skeleton, LoadingLabel } from "@/components/kit/Skeleton";
import { cliCheck, cliInstallCancel, cliInstallPlan, cliInstallRun, type CliCheck } from "@/app/connections/actions";
import { splitHint } from "@/lib/cli-hint";
import type { InstallJob, InstallPlan, LogEntry } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { InstallProgress, type InstallPhase } from "./InstallProgress";
import { LoginSteps } from "./LoginSteps";

type Phase = "planning" | "review" | "starting" | "plan-error" | InstallPhase;

/**
 * Install flow: 1) read the exact plan (nothing runs yet), 2) confirm, 3) watch progress.
 * The plan is fetched through a server action; progress arrives over SSE from our own origin.
 */
export default function InstallDialog({
  provider,
  name,
  loginHint,
  onClose,
}: {
  provider: string;
  name: string;
  loginHint: string | null | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [phase, setPhase] = React.useState<Phase>("planning");
  const [plan, setPlan] = React.useState<InstallPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [job, setJob] = React.useState<InstallJob | null>(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const [installed, setInstalled] = React.useState<CliCheck | null>(null);
  const planned = React.useRef(false);

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
    if (!job) return;
    const es = new EventSource(`/api/install/${job.id}/events`);
    es.addEventListener("log", (e) => {
      setReconnecting(false);
      setEntries((prev) => [...prev, JSON.parse((e as MessageEvent).data) as LogEntry]);
    });
    es.addEventListener("exit", async (e) => {
      es.close();
      const { state } = JSON.parse((e as MessageEvent).data) as { state: InstallPhase };
      setPhase(state);
      if (state === "ok") {
        // A fresh probe flips the card; it also says where the binary landed and whether a new
        // terminal can find it, which the "Log in next" step needs.
        const r = await cliCheck();
        if (r.ok) setInstalled(r.data[provider] ?? null);
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
  }, [job, name, provider, push, router]);

  const confirm = async () => {
    if (!plan) return;
    setPhase("starting");
    const r = await cliInstallRun(provider, plan.plan_id);
    if (!r.ok) {
      setError(r.error);
      setPhase("plan-error");
      return;
    }
    setEntries([]);
    setInstalled(null);
    setJob(r.data);
    setPhase("running");
  };

  const running = phase === "running" || phase === "starting";
  const finished = phase === "ok" || phase === "failed" || phase === "cancelled" || phase === "timeout";
  const { command, note } = splitHint(loginHint);

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
              <h3 id="install-commands" className="label">
                {t("install.commands")}
              </h3>
              <pre className="solid-panel overflow-x-auto p-3" tabIndex={0} aria-label={t("install.commands")}>
                {plan.commands.map((c) => `$ ${c}`).join("\n")}
              </pre>
            </section>

            <section aria-labelledby="install-effects" className="grid gap-1.5">
              <h3 id="install-effects" className="label">
                {t("install.effects")}
              </h3>
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

        {(running || finished) && plan && (
          <div className="grid gap-4">
            <InstallProgress
              name={name}
              version={plan.version}
              phase={running ? "running" : (phase as InstallPhase)}
              entries={entries}
              error={phase === "failed" ? error : null}
              reconnecting={reconnecting}
              next={
                phase === "ok" ? (
                  installed ? (
                    <section aria-labelledby="login-next" className="grid gap-2 rounded-control border border-hairline bg-glass-strong p-3">
                      <h3 id="login-next" className="font-display text-base font-bold tracking-tight">
                        {t("cli.loginNext")}
                      </h3>
                      <LoginSteps
                        headingAs="h3"
                        command={command}
                        note={note}
                        binPath={installed.bin_path}
                        binDir={installed.bin_dir}
                        onUserPath={installed.on_user_path}
                      />
                    </section>
                  ) : (
                    <p className="text-sm text-ink-muted">{t("install.checking")}</p>
                  )
                ) : null
              }
            />
            <div className="flex flex-wrap gap-2">
              {running ? (
                <Button variant="danger" size="sm" disabled={!job} onClick={() => job && void cliInstallCancel(job.id)}>
                  {t("install.stop")}
                </Button>
              ) : (
                <>
                  <Button size="sm" onClick={onClose}>
                    {phase === "ok" ? t("install.doneButton") : t("install.close")}
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
