"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Ban, ExternalLink, ShieldAlert, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { packCheck, packRollback, packUninstall } from "@/app/connections/pack-actions";
import { HOST_LABELS, type PackRow } from "@/lib/packs-types";
import { tPacks } from "@/i18n/packs";

// The dialog (Radix + EventSource log) loads the first time someone clicks Install.
const PackInstallDialog = dynamic(() => import("./PackInstallDialog"), { ssr: false });

/** One workflow pack in the library: what it is, whether it is installed, and the store actions. */
export function PackCard({ pack, hostprobe }: { pack: PackRow; hostprobe: boolean }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [installing, setInstalling] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "rollback" | "remove" | "check">(null);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const blocked = !pack.installable;

  const act = async (kind: "rollback" | "remove" | "check") => {
    setBusy(kind);
    setNote(null);
    if (kind === "check") {
      const r = await packCheck(pack.id);
      setBusy(null);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      const v = r.data.verify;
      return setNote(v.ok ? { ok: true, text: tPacks("card.checkOk", { files: v.files ?? 0, ms: v.ms }) } : { ok: false, text: v.problem ?? "" });
    }
    const r = kind === "rollback" ? await packRollback(pack.id) : await packUninstall(pack.id);
    setBusy(null);
    setConfirmRemove(false);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    push({
      tone: "success",
      title: kind === "rollback" ? tPacks("card.rolledBack", { name: pack.name, version: pack.previous ?? "" }) : tPacks("card.removed", { name: pack.name }),
    });
    router.refresh();
  };

  return (
    <GlassPanel as="article" aria-labelledby={`${ids}-h`} className="lift grid content-start gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`${ids}-h`} className="font-display text-lg font-bold tracking-tight">
          {pack.name}
        </h3>
        {pack.trust === "verified" ? (
          <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-ok">
            <ShieldCheck aria-hidden className="size-3.5" /> {tPacks("card.verified")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-warn">
            <ShieldAlert aria-hidden className="size-3.5" /> {tPacks("card.unverified")}
          </span>
        )}
      </div>
      <p className="text-sm">{pack.summary}</p>
      {blocked ? (
        <p className="flex items-start gap-1.5 text-sm text-ink-muted" role="note">
          <Ban aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold text-ink">{pack.refused ? tPacks("card.refused") : tPacks("card.lockProblem")}: </span>
            {pack.refused ?? pack.lock_problem}
          </span>
        </p>
      ) : (
        <StatusBadge
          status={pack.installed ? "healthy" : "offline"}
          label={pack.installed ? tPacks("card.installed", { version: pack.installed }) : tPacks("card.notInstalled")}
        />
      )}
      <dl className="grid gap-1.5 text-[0.8125rem]">
        {pack.package && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-muted">{tPacks("card.source")}</dt>
            <dd className="min-w-0 font-mono break-all">
              {pack.package}
              {pack.version ? ` ${pack.version}` : ""}
            </dd>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-ink-muted">{tPacks("card.hosts")}</dt>
          <dd>{pack.hosts.map((h) => HOST_LABELS[h] ?? h).join(", ")}</dd>
        </div>
        {pack.flows.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center gap-x-2">
            <dt className="inline-flex items-center gap-1 text-ink-muted">
              <Workflow aria-hidden className="size-3.5" /> {tPacks("card.flows")}
            </dt>
            <dd>{f.steps.join(" → ")}</dd>
          </div>
        ))}
        {pack.auto && (
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="inline-flex items-center gap-1 text-ink-muted">
              <Sparkles aria-hidden className="size-3.5" /> {tPacks("card.auto")}
            </dt>
            <dd>{tPacks("card.autoHelp")}</dd>
          </div>
        )}
      </dl>
      {pack.repository && (
        <a href={pack.repository} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-[0.8125rem] font-semibold text-accent-strong underline underline-offset-2">
          {pack.repository.replace(/^https:\/\//, "")}
          <ExternalLink aria-hidden className="size-3.5 shrink-0" />
        </a>
      )}
      {!blocked && hostprobe && (
        <div className="flex flex-wrap gap-2">
          {(!pack.installed || pack.update) && (
            <Button size="sm" onClick={() => setInstalling(true)}>
              {pack.update ? tPacks("card.updateTo", { version: pack.version ?? "" }) : tPacks("card.install")}
            </Button>
          )}
          {pack.installed && (
            <Button size="sm" variant="glass" loading={busy === "check"} disabled={!!busy} onClick={() => act("check")}>
              {tPacks("card.check")}
            </Button>
          )}
          {pack.previous && (
            <Button size="sm" variant="glass" loading={busy === "rollback"} disabled={!!busy} onClick={() => act("rollback")}>
              {tPacks("card.rollback", { version: pack.previous })}
            </Button>
          )}
          {pack.installed && !confirmRemove && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirmRemove(true)}>
              {tPacks("card.remove")}
            </Button>
          )}
        </div>
      )}
      {confirmRemove && (
        <div role="alertdialog" aria-labelledby={`${ids}-rm`} className="grid gap-2 rounded-control border border-hairline bg-glass-strong p-3 text-sm">
          <p id={`${ids}-rm`}>{tPacks("card.removeConfirm", { name: pack.name })}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={busy === "remove"} onClick={() => act("remove")}>
              {tPacks("card.removeYes")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
              {tPacks("card.keep")}
            </Button>
          </div>
        </div>
      )}
      <p aria-live="polite" className={note ? (note.ok ? "text-sm text-ok" : "text-sm text-err") : "sr-only"}>
        {note?.text ?? ""}
      </p>
      {installing && <PackInstallDialog pack={pack} onClose={() => setInstalling(false)} />}
    </GlassPanel>
  );
}
