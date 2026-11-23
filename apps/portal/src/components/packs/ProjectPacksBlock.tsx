"use client";

import * as React from "react";
import Link from "next/link";
import { Package } from "lucide-react";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { setProjectPacks } from "@/app/jobs/actions";
import { HOST_LABELS, type PackRow, type ProjectPacks } from "@/lib/packs-types";
import { tPacks } from "@/i18n/packs";

type Change = { enabled?: boolean; mode?: "auto" | "always" | "off"; hosts?: string[]; turn_back_on?: boolean };

/** Settings → Projects (M4.5a): which installed packs this project uses, for which agents, and graphify's mode. */
export function ProjectPacksBlock({ projectId, library, initial }: { projectId: number; library: PackRow[]; initial: ProjectPacks["packs"] | null }) {
  const { push } = useToast();
  const ids = React.useId();
  const [st, setSt] = React.useState(initial ?? {});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const usable = library.filter((p) => p.installable);
  const installed = usable.filter((p) => p.installed);

  const save = async (id: string, change: Change) => {
    const before = st;
    // Shown at once; put back if the router refuses.
    if (!change.turn_back_on) setSt((cur) => ({ ...cur, [id]: { ...cur[id], ...change } as (typeof cur)[string] }));
    setBusy(true);
    setError(null);
    const r = await setProjectPacks(projectId, { [id]: change });
    setBusy(false);
    if (!r.ok) {
      setSt(before);
      return setError(r.error);
    }
    setSt(r.data.packs);
    push({ tone: "success", title: tPacks("project.saved") });
  };

  return (
    <section aria-labelledby={`${ids}-h`} className="grid gap-3 border-t border-hairline pt-3 text-sm">
      <h3 id={`${ids}-h`} className="flex items-center gap-1.5 font-semibold">
        <Package aria-hidden className="size-4 text-ink-muted" /> {tPacks("project.title")}
      </h3>
      <p className="text-[0.8125rem] text-ink-muted">{tPacks("project.lead")}</p>
      {!installed.length && (
        <p>
          {tPacks("project.none")}{" "}
          <Link href="/connections#sec-packs" className="font-semibold text-accent-strong underline underline-offset-2">
            {tPacks("project.library")}
          </Link>
        </p>
      )}
      {usable.map((p) => {
        const cur = st[p.id];
        if (!cur) return null;
        if (!p.installed)
          return (
            <p key={p.id} className="text-ink-muted">
              {tPacks("project.notInstalled", { name: p.name })}{" "}
              <Link href="/connections#sec-packs" className="font-semibold text-accent-strong underline underline-offset-2">
                {tPacks("project.library")}
              </Link>
            </p>
          );
        const hostsId = `${ids}-${p.id}-hosts`;
        return (
          <div key={p.id} className="grid gap-2 rounded-control border border-hairline p-3">
            {p.auto === "graph" ? (
              <fieldset className="grid gap-1.5">
                <legend className="font-semibold">{tPacks("project.graph")}</legend>
                <div role="radiogroup" aria-label={tPacks("project.graph")} className="flex flex-wrap gap-3">
                  {(["auto", "always", "off"] as const).map((m) => (
                    <label key={m} className="flex items-center gap-1.5">
                      <input type="radio" name={`${ids}-${p.id}-mode`} checked={cur.mode === m} disabled={busy} onChange={() => save(p.id, { mode: m })} className="size-4" />
                      {tPacks(`project.mode.${m}`)}
                    </label>
                  ))}
                </div>
                <p className="text-[0.8125rem] text-ink-muted">
                  {tPacks(`project.modeHelp.${cur.mode ?? "auto"}`, {
                    files: cur.auto_threshold?.min_files ?? 0,
                    mb: Math.round((cur.auto_threshold?.min_bytes ?? 0) / 1e6),
                  })}
                </p>
              </fieldset>
            ) : (
              <label className="flex items-center gap-2 font-semibold">
                <Switch checked={!!cur.enabled} disabled={busy} onCheckedChange={(v) => save(p.id, { enabled: v })} aria-describedby={hostsId} />
                {tPacks("project.enabled", { name: p.name })}
              </label>
            )}
            <fieldset id={hostsId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <legend className="mb-1 text-[0.8125rem] text-ink-muted">{tPacks("project.hosts")}</legend>
              {p.hosts.map((h) => (
                <label key={h} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="size-4"
                    disabled={busy}
                    checked={cur.hosts.includes(h)}
                    onChange={(e) => save(p.id, { hosts: e.target.checked ? [...cur.hosts, h] : cur.hosts.filter((x) => x !== h) })}
                  />
                  {HOST_LABELS[h] ?? h}
                </label>
              ))}
            </fieldset>
            {p.auto === "graph" && (
              <div className="grid gap-1">
                <p className="text-[0.8125rem] font-semibold">{tPacks("project.measuring")}</p>
                {cur.groups?.length ? (
                  <ul className="grid gap-1">
                    {cur.groups.map((g) => (
                      <li key={g.group} className="flex flex-wrap items-center gap-x-2">
                        <span>{tPacks("project.groupFlow", { agent: HOST_LABELS[g.agent] ?? g.agent, flow: g.flow ?? tPacks("project.plain") })}:</span>
                        <span className={g.state === "off" ? "font-semibold text-warn" : "font-semibold"}>{g.status}</span>
                        {g.state === "off" && (
                          <Button size="sm" variant="glass" disabled={busy} onClick={() => save(p.id, { turn_back_on: true })}>
                            {tPacks("project.turnBackOn")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[0.8125rem] text-ink-muted">{tPacks("project.noGroups")}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" className="text-err">
          {error}
        </p>
      )}
    </section>
  );
}
