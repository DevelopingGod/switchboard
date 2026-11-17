"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AlertTriangle, TerminalSquare } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge, type Status } from "@/components/kit/StatusBadge";
import { CostBadge } from "@/components/kit/CostBadge";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { cliCheck } from "@/app/connections/actions";
import type { ConnectionRow } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { type ConnectionKey, tConn } from "@/i18n/connections";
import { splitHint } from "@/lib/cli-hint";
import { LoginSteps } from "./LoginSteps";
import { PrivacyLine } from "./shared";

// The dialog (Radix + EventSource log) loads the first time someone clicks Install.
const InstallDialog = dynamic(() => import("./InstallDialog"), { ssr: false });

const statusVisual: Record<string, Status> = {
  logged_in: "healthy",
  logged_out: "warning",
  installed: "warning",
  windows_only: "offline",
  not_installed: "offline",
  unknown: "offline",
};

/** A subscription / agent CLI: installed, Windows-only, not installed, or logged in. Login stays in the terminal. */
export function CliProviderCard({ row }: { row: ConnectionRow }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [installing, setInstalling] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);

  const status = row.status in statusVisual ? row.status : "unknown";
  const canInstall = status === "not_installed" || status === "windows_only";
  const needsLogin = status === "logged_out" || status === "installed";
  const { command, note: loginNote } = splitHint(row.login_hint);

  const check = async () => {
    setChecking(true);
    setNote(null);
    const r = await cliCheck();
    setChecking(false);
    if (!r.ok) setNote({ ok: false, text: `${tConn("cli.checkFailed")}: ${r.error}` });
    else if (r.data[row.provider]?.status === "logged_in" && status !== "logged_in") {
      setNote({ ok: true, text: tConn("cli.nowLoggedIn", { name: row.name }) });
      push({ tone: "success", title: tConn("cli.nowLoggedIn", { name: row.name }) });
    } else if (needsLogin && r.data[row.provider]?.status !== "logged_in") setNote({ ok: false, text: tConn("cli.stillLoggedOut") });
    router.refresh();
  };

  return (
    <GlassPanel as="article" aria-labelledby={`${ids}-h`} className="grid content-start gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
            <TerminalSquare className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 id={`${ids}-h`} className="line-clamp-2 font-display text-lg leading-tight font-bold tracking-tight">
              {row.name}
            </h3>
            <p className="label">{t("provider.cli")}</p>
          </div>
        </div>
        <StatusBadge status={statusVisual[status]} label={tConn(`cli.status.${status}` as ConnectionKey)} />
      </header>

      <div className="surface-strong grid gap-2 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <CostBadge kind={row.paid ? "paid" : "free"} amount={tConn("cli.subscription")} />
          {row.version && <span className="font-mono text-ink-muted">{tConn("cli.version", { version: row.version })}</span>}
        </div>
        <PrivacyLine privacy={row.privacy} />
        {row.notes && <p className="text-ink-muted">{row.notes}</p>}
        {status === "windows_only" && <p className="text-ink-muted">{tConn("cli.windowsOnlyNote")}</p>}
        {status === "unknown" && (
          <p className="flex items-start gap-1.5 text-ink-muted">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
            {tConn("cli.unknownNote")}
          </p>
        )}
      </div>

      {needsLogin && (
        <LoginSteps
          command={command}
          note={loginNote}
          binPath={row.bin_path}
          binDir={row.bin_dir}
          onUserPath={row.on_user_path}
        />
      )}

      <p role="status" className={note?.text ? (note.ok ? "text-sm text-ok" : "text-sm text-err") : "sr-only"}>
        {note?.text}
      </p>

      <footer className="flex flex-wrap items-center gap-2">
        {canInstall && (
          <Button size="sm" onClick={() => setInstalling(true)}>
            {tConn("cli.install")}
          </Button>
        )}
        {(needsLogin || status === "logged_in" || status === "unknown") && (
          <Button
            size="sm"
            variant={needsLogin ? "primary" : "ghost"}
            loading={checking}
            onClick={check}
          >
            {checking ? tConn("cli.checking") : tConn("cli.checkAgain")}
          </Button>
        )}
      </footer>

      {installing && (
        <InstallDialog
          provider={row.provider}
          name={row.name}
          loginHint={row.login_hint}
          onClose={() => {
            setInstalling(false);
            router.refresh();
          }}
        />
      )}
    </GlassPanel>
  );
}
