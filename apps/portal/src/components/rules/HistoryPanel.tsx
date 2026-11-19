"use client";

import * as React from "react";
import { History as HistoryIcon, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { useToast } from "@/components/kit/Toast";
import { loadDiff, loadVersions, rollbackRules } from "@/app/settings/rules/actions";
import type { RulesDiffChange, RulesVersion } from "@/lib/router-types";
import { pathLabel } from "@/lib/rules-model";
import { cn } from "@/lib/cn";
import { tRules } from "@/i18n/rules";

const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso)) + " UTC";
const show = (v: unknown) => (v === null || v === undefined ? "—" : Array.isArray(v) ? v.join(" → ") || "none" : typeof v === "object" ? JSON.stringify(v) : String(v));

function Diff({ changes }: { changes: RulesDiffChange[] }) {
  if (changes.length === 0) return <p className="text-sm text-ink-muted">{tRules("history.noDiff")}</p>;
  return (
    <ul className="grid gap-1.5 text-sm">
      {changes.map((c) => (
        <li key={c.path} className="grid gap-0.5 rounded-control bg-glass px-3 py-2">
          <span className="font-semibold">
            <span className="mr-1.5 rounded-chip bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-bold text-accent-strong">{tRules(`history.${c.kind}`)}</span>
            {pathLabel(c.path)}
          </span>
          <span className="break-words text-ink-muted">
            {c.kind !== "added" && (
              <>
                {tRules("history.from")} <code className="font-mono">{show(c.before)}</code>{" "}
              </>
            )}
            {c.kind !== "removed" && (
              <>
                {tRules("history.to")} <code className="font-mono">{show(c.after)}</code>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function HistoryPanel({
  initial,
  next: initialNext,
  currentId,
  onRolledBack,
}: {
  initial: RulesVersion[];
  next: number | null;
  currentId: number | null;
  onRolledBack: () => void;
}) {
  const { push } = useToast();
  const [versions, setVersions] = React.useState(initial);
  const [next, setNext] = React.useState(initialNext);
  const [open, setOpen] = React.useState<number | null>(null);
  const [diff, setDiff] = React.useState<Record<number, RulesDiffChange[]>>({});
  const [confirm, setConfirm] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  // The screen re-mounts this panel (key = current version) after a save or rollback, so state starts fresh.

  const toggle = async (id: number) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!diff[id]) {
      const r = await loadDiff(id, "previous");
      if (r.ok) setDiff((d) => ({ ...d, [id]: r.data.changes }));
      else push({ tone: "error", title: r.error });
    }
  };
  const more = async () => {
    setBusy(true);
    const r = await loadVersions(next);
    setBusy(false);
    if (!r.ok) return push({ tone: "error", title: r.error });
    setVersions((v) => [...v, ...r.data.versions.filter((n) => !v.some((x) => x.id === n.id))]);
    setNext(r.data.next_before);
  };
  const rollback = async (id: number) => {
    setBusy(true);
    const r = await rollbackRules(id);
    setBusy(false);
    setConfirm(null);
    if (!r.ok) return push({ tone: "error", title: r.error });
    push({ tone: "success", title: tRules("history.rolled", { id }) });
    onRolledBack();
  };

  return (
    <GlassPanel as="section" tone="strong" aria-labelledby="hist-h" className="grid gap-4">
      <header className="grid gap-1">
        <h2 id="hist-h" className="flex items-center gap-2 font-display text-xl font-bold tracking-tight">
          <HistoryIcon aria-hidden className="size-5 text-accent-strong" /> {tRules("history.heading")}
        </h2>
        <p className="text-sm text-ink-muted">{tRules("history.help")}</p>
      </header>
      {versions.length === 0 ? (
        <p className="text-sm text-ink-muted">{tRules("history.empty")}</p>
      ) : (
        <ol className="grid gap-2">
          {versions.map((v) => {
            const isCurrent = v.id === currentId;
            return (
              <li key={v.id} className={cn("grid gap-2 rounded-control border border-hairline bg-glass p-3", isCurrent && "ring-2 ring-accent-strong")}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid gap-0.5">
                    <span className="font-semibold">
                      {tRules("history.version", { id: v.id })}
                      {isCurrent && <span className="ml-2 rounded-chip bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-bold text-accent-strong">{tRules("history.current")}</span>}
                    </span>
                    <span className="text-[0.8125rem] text-ink-muted">
                      {when(v.created_at)} · {tRules(`history.source.${v.source}`)} · {v.changes === 1 ? tRules("history.changesOne") : tRules("history.changes", { count: v.changes })}
                    </span>
                    {(v.note || v.rolled_back_to) && <span className="text-sm">{v.note ?? tRules("history.rolledBack", { id: v.rolled_back_to ?? 0 })}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" size="sm" variant="glass" aria-expanded={open === v.id} onClick={() => toggle(v.id)}>
                      {open === v.id ? tRules("history.hide") : tRules("history.show")}
                    </Button>
                    {!isCurrent && confirm !== v.id && (
                      <Button type="button" size="sm" variant="glass" disabled={busy} onClick={() => setConfirm(v.id)}>
                        <Undo2 aria-hidden className="size-4" /> {tRules("history.rollback")}
                      </Button>
                    )}
                  </div>
                </div>
                {confirm === v.id && (
                  <div role="group" aria-label={tRules("history.rollbackConfirm", { id: v.id })} className="flex flex-wrap items-center gap-2 rounded-control border border-err p-2 text-sm">
                    <span className="font-semibold">{tRules("history.rollbackConfirm", { id: v.id })}</span>
                    <Button type="button" size="sm" variant="danger" autoFocus disabled={busy} onClick={() => rollback(v.id)}>
                      {tRules("history.rollbackYes")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                      {tRules("bar.discard")}
                    </Button>
                  </div>
                )}
                {open === v.id && (
                  <div className="grid gap-2">
                    <p className="text-[0.8125rem] text-ink-muted">{tRules("history.diffAgainst")}</p>
                    {diff[v.id] ? <Diff changes={diff[v.id]} /> : <p className="text-sm text-ink-muted">{tRules("history.loading")}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {next !== null && (
        <Button type="button" size="sm" variant="glass" disabled={busy} onClick={more} className="justify-self-start">
          {busy ? tRules("history.loading") : tRules("history.more")}
        </Button>
      )}
    </GlassPanel>
  );
}
