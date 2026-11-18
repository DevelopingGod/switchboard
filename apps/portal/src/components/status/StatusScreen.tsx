"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Wrench } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { useToast } from "@/components/kit/Toast";
import { ErrorNote } from "@/components/kit/ErrorNote";
import { Button } from "@/components/ui/button";
import { cliCheck, testConnection } from "@/app/connections/actions";
import { resyncModels } from "@/app/status/actions";
import { usePrefs } from "@/lib/prefs";
import type { ActionResult, ComponentsResponse, SystemComponent } from "@/lib/router-types";
import { type StatusKey, statusStrings, tStatus } from "@/i18n/status";
import { tErr } from "@/i18n/errors";

type InAppFix = "resync" | "recheck_cli" | "retest";

const knownId = (id: string): id is keyof typeof statusStrings.name => id in statusStrings.name;

function label(c: SystemComponent): string {
  return knownId(c.id) ? tStatus(`name.${c.id}`) : (c.name ?? c.id.replace(/^provider:/, ""));
}

function sentence(c: SystemComponent): string {
  const key = knownId(c.id) ? c.id : "provider";
  if (c.status === "ok") return tStatus(`ok.${key}` as StatusKey);
  if (c.status === "degraded" && key === "model_sync") return tStatus("degraded.model_sync");
  return tStatus(`down.${key}` as StatusKey);
}

function fixOf(c: SystemComponent): { kind: InAppFix; arg?: string } | { instruction: string } | null {
  if (!c.fix) return null;
  if (c.fix === "resync" || c.fix === "recheck_cli") return { kind: c.fix };
  if (c.fix.startsWith("retest:")) return { kind: "retest", arg: c.fix.slice(7) };
  return c.fix in statusStrings.instruction ? { instruction: tStatus(`instruction.${c.fix}` as StatusKey) } : null;
}

/** Every component Switchboard runs on, with an in-app fix where there is one (M1.5, self-healing). */
export function StatusScreen({ data }: { data: ComponentsResponse }) {
  const router = useRouter();
  const { push } = useToast();
  const { mode } = usePrefs();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<Record<string, { code?: string; detail?: string | null }>>({});
  const [refreshing, startRefresh] = React.useTransition();
  const down = data.components.filter((c) => c.status !== "ok").length;

  const run = async (c: SystemComponent, kind: InAppFix, arg?: string) => {
    setBusy(c.id);
    let r: ActionResult<unknown>;
    if (kind === "resync") r = await resyncModels();
    else if (kind === "recheck_cli") r = await cliCheck();
    else {
      const t = await testConnection(arg ?? "");
      r = t.ok && !t.data.ok ? { ok: false, error: t.data.error ?? "", code: t.data.error_code, detail: t.data.error } : t;
    }
    setBusy(null);
    if (r.ok) {
      setFailed((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== c.id)));
      push({ tone: "success", title: tStatus(`done.${kind}`) });
    } else setFailed((f) => ({ ...f, [c.id]: { code: r.ok ? undefined : r.code, detail: r.ok ? null : (r.detail ?? r.error) } }));
    router.refresh();
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-lg font-semibold">
          {down === 0 ? tStatus("allOk") : tStatus("someDown", { count: down })}
        </p>
        <Button size="sm" variant="glass" loading={refreshing} onClick={() => startRefresh(() => router.refresh())}>
          <RefreshCw aria-hidden className="size-4" />
          {tStatus("refresh")}
        </Button>
      </div>
      <GlassPanel as="section" tone="strong" aria-label={tStatus("title")} className="p-0">
        <ul className="divide-y divide-hairline">
          {data.components.map((c) => {
            const fix = c.status === "ok" ? null : fixOf(c);
            const err = failed[c.id];
            return (
              <li key={c.id} className="grid gap-2 p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
                <div className="grid gap-1">
                  <p className="truncate font-semibold">{label(c)}</p>
                  <StatusBadge
                    status={c.status === "ok" ? "healthy" : c.status === "degraded" ? "warning" : "error"}
                  />
                </div>
                <div className="grid min-w-0 gap-1.5 text-sm">
                  <p className={c.status === "ok" ? "text-ink-muted" : "text-ink"}>{sentence(c)}</p>
                  {fix && "instruction" in fix && (
                    <p className="flex items-start gap-1.5 text-ink-muted">
                      <Wrench aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>
                        <span className="font-semibold text-ink">{tStatus("howTo")}: </span>
                        {fix.instruction}
                      </span>
                    </p>
                  )}
                  {err && <ErrorNote live code={err.code} detail={err.detail} />}
                  {mode === "pro" && c.detail && !err && (
                    <details className="text-xs text-ink-muted">
                      <summary className="cursor-pointer font-semibold select-none">{tErr("details")}</summary>
                      <pre className="solid-panel mt-1 max-h-32 overflow-auto p-2 font-mono break-words whitespace-pre-wrap">{c.detail}</pre>
                    </details>
                  )}
                </div>
                {fix && "kind" in fix && (
                  <Button size="sm" variant="glass" loading={busy === c.id} onClick={() => run(c, fix.kind, fix.arg)}>
                    {tStatus(`fix.${fix.kind}`)}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </GlassPanel>
    </div>
  );
}
