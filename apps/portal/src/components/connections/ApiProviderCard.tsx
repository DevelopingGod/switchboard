"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Cpu, KeyRound } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { CostBadge } from "@/components/kit/CostBadge";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { removeKey, saveKey, testConnection } from "@/app/connections/actions";
import type { CatalogModel, ConnectionRow } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tConn } from "@/i18n/connections";
import { PrivacyLine } from "./shared";
import { RecommendedModels } from "./RecommendedModels";

type Mode = "view" | "add" | "confirm-remove";
type Busy = null | "save" | "test" | "remove";

/** An API-key provider (or the local Ollama): paste key → check → store; test; remove. */
export function ApiProviderCard({ row, models }: { row: ConnectionRow; models: CatalogModel[] }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const isLocal = row.kind === "local";
  const hasKey = !!row.key_last4;
  const [mode, setMode] = React.useState<Mode>("view");
  const [key, setKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);

  const connected = row.status === "connected";
  const failing = row.status === "error";
  const Icon = isLocal ? Cpu : KeyRound;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setError(null);
    const r = await saveKey(row.provider, key);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      router.refresh();
      return;
    }
    setKey("");
    setMode("view");
    setNote(null);
    push({ tone: "success", title: tConn("card.saved", { name: row.name }) });
    router.refresh();
  };

  const test = async () => {
    setBusy("test");
    setNote(null);
    const r = await testConnection(row.provider);
    setBusy(null);
    const ok = r.ok && r.data.ok;
    setNote({ ok, text: ok ? tConn("card.testOk", { name: row.name }) : `${tConn("card.testFailed")}: ${r.ok ? (r.data.error ?? "") : r.error}` });
    router.refresh();
  };

  const remove = async () => {
    setBusy("remove");
    const r = await removeKey(row.provider);
    setBusy(null);
    setMode("view");
    if (!r.ok) setNote({ ok: false, text: r.error });
    else {
      setNote(null);
      push({ tone: "info", title: tConn("card.removed", { name: row.name }) });
    }
    router.refresh();
  };

  return (
    <GlassPanel as="article" aria-labelledby={`${ids}-h`} className="grid content-start gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 id={`${ids}-h`} className="line-clamp-2 font-display text-lg leading-tight font-bold tracking-tight">
              {row.name}
            </h3>
            <p className="label">{isLocal ? t("provider.local") : t("provider.api")}</p>
          </div>
        </div>
        {connected ? (
          <StatusBadge status="healthy" label={tConn("card.connected")} />
        ) : failing ? (
          <StatusBadge status="error" label={tConn("card.needsAttention")} />
        ) : (
          <StatusBadge status="offline" label={tConn("card.notConnected")} />
        )}
      </header>

      <div className="surface-strong grid gap-2 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <CostBadge kind={row.paid ? "paid" : "free"} amount={t("provider.paid")} />
          {hasKey && <span className="font-mono text-ink-muted">{tConn("card.keyLast4", { last4: row.key_last4 ?? "" })}</span>}
          {typeof row.models_available === "number" && row.models_available > 0 && (
            <span className="text-ink-muted">{tConn("card.models", { count: row.models_available })}</span>
          )}
        </div>
        <PrivacyLine privacy={row.privacy} />
        {row.free_limits && (
          <p className="text-ink-muted">
            <span className="font-semibold text-ink">{tConn("card.limits")}: </span>
            {row.free_limits}
          </p>
        )}
        {row.notes && <p className="text-ink-muted">{row.notes}</p>}
      </div>

      {row.last_error && (
        <p className="flex items-start gap-1.5 text-sm text-err">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">{t("provider.lastError")}: </span>
            {row.last_error}
          </span>
        </p>
      )}

      {(hasKey || isLocal) && <RecommendedModels provider={row.provider} models={models} />}

      {mode === "add" && (
        <form onSubmit={submit} className="grid gap-2">
          <label htmlFor={`${ids}-key`} className="label">
            {tConn("card.keyLabel", { name: row.name })}
          </label>
          <input
            id={`${ids}-key`}
            type="password"
            name="api-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            data-1p-ignore
            required
            minLength={8}
            aria-describedby={`${ids}-help ${error ? `${ids}-err` : ""}`}
            aria-invalid={error ? true : undefined}
            className="min-h-(--ctl) w-full rounded-control border border-hairline bg-glass-strong px-3 font-mono text-sm text-ink placeholder:text-ink-muted"
          />
          <p id={`${ids}-help`} className="text-xs text-ink-muted">
            {tConn("card.keyHelp", { name: row.name })}
          </p>
          {error && (
            <p id={`${ids}-err`} role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy === "save"} disabled={key.trim().length < 8}>
              {busy === "save" ? tConn("card.saving") : tConn("card.saveKey")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy === "save"}
              onClick={() => {
                setMode("view");
                setKey("");
                setError(null);
              }}
            >
              {tConn("card.cancel")}
            </Button>
          </div>
        </form>
      )}

      {mode === "confirm-remove" && (
        <div role="alertdialog" aria-label={tConn("card.removeKey")} className="grid gap-2 rounded-control border border-err bg-glass-strong p-3">
          <p className="text-sm">{tConn("card.confirmRemove")}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={busy === "remove"} onClick={remove}>
              {tConn("card.confirmRemoveYes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")} disabled={busy === "remove"}>
              {tConn("card.keep")}
            </Button>
          </div>
        </div>
      )}

      <p role="status" className={note ? (note.ok ? "text-sm text-ok" : "text-sm text-err") : "sr-only"}>
        {note?.text}
      </p>

      {mode === "view" && (
        <footer className="flex flex-wrap gap-2">
          {isLocal ? (
            <Button size="sm" variant="glass" loading={busy === "test"} onClick={test}>
              {busy === "test" ? tConn("card.testing") : tConn("card.testConnection")}
            </Button>
          ) : hasKey ? (
            <>
              <Button size="sm" variant="glass" loading={busy === "test"} onClick={test}>
                {busy === "test" ? tConn("card.testing") : tConn("card.testConnection")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("add")}>
                {tConn("card.replaceKey")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("confirm-remove")}>
                {tConn("card.removeKey")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setMode("add")}>
              {tConn("card.addKey")}
            </Button>
          )}
        </footer>
      )}
    </GlassPanel>
  );
}
