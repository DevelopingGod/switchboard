"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FolderGit2, FolderPlus, HardDrive, Trash2 } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { EmptyState } from "@/components/kit/EmptyState";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { addProject, cleanupProject, loadWorktrees, removeProject, setProjectAccounts } from "@/app/jobs/actions";
import { saveSettings } from "@/app/settings/actions";
import { bytes } from "@/lib/job-format";
import type { AccountsResponse, ProjectRow, ProjectWorktrees } from "@/lib/router-types";
import { tJobs } from "@/i18n/jobs";
import { tSubs } from "@/i18n/subscriptions";
import { ProjectPacksBlock } from "@/components/packs/ProjectPacksBlock";
import type { PackRow, ProjectPacks } from "@/lib/packs-types";

function ProjectItem({
  p,
  onRemoved,
  initial,
  accounts,
  library,
  packs,
}: {
  p: ProjectRow;
  onRemoved: () => void;
  initial: ProjectWorktrees | null | undefined;
  accounts: AccountsResponse["clis"];
  library: PackRow[] | null;
  packs: ProjectPacks["packs"] | null | undefined;
}) {
  const { push } = useToast();
  const [wt, setWt] = React.useState<ProjectWorktrees | null>(initial ?? null);
  const [wtError, setWtError] = React.useState(initial === null);
  const [busy, setBusy] = React.useState<null | "remove" | "cleanup">(null);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();

  React.useEffect(() => {
    if (initial !== undefined) return; // came with the page (a project added here loads its own)
    let alive = true;
    void loadWorktrees(p.id).then((r) => {
      if (!alive) return;
      if (r.ok) setWt(r.data);
      else setWtError(true);
    });
    return () => {
      alive = false;
    };
  }, [p.id, initial]);

  const remove = async () => {
    setBusy("remove");
    setError(null);
    const r = await removeProject(p.id);
    setBusy(null);
    setConfirm(false);
    if (!r.ok) return setError(r.error);
    push({ tone: "success", title: tJobs("projects.removed", { name: p.name }) });
    onRemoved();
  };

  const cleanup = async () => {
    setBusy("cleanup");
    setError(null);
    const r = await cleanupProject(p.id);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setWt((cur) => ({ ...r.data, keep: cur?.keep ?? r.data.keep }));
    push({ tone: "success", title: tJobs("projects.cleaned", { name: p.name }) });
  };

  return (
    <li>
      <GlassPanel as="article" tone="strong" aria-labelledby={`${ids}-h`} className="grid gap-3">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-0.5">
            <h2 id={`${ids}-h`} className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
              <FolderGit2 aria-hidden className="size-5 text-accent-strong" /> {p.name}
            </h2>
            <p className="font-mono text-[0.8125rem] break-all text-ink-muted">{p.path}</p>
            <p className="text-[0.8125rem] text-ink-muted">
              {tJobs("projects.jobs", { n: p.jobs })}
              {p.active_jobs ? ` · ${tJobs("projects.active", { n: p.active_jobs })}` : ""}
              {p.head_branch ? ` · ${p.head_branch}` : ""}
            </p>
          </div>
          {!confirm && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              <Trash2 aria-hidden className="size-4" /> {tJobs("projects.remove")}
            </Button>
          )}
        </header>
        {confirm && (
          <div role="alertdialog" aria-labelledby={`${ids}-c`} className="grid gap-2 rounded-control border border-hairline p-3 text-sm">
            <p id={`${ids}-c`}>{tJobs("projects.removeConfirm", { name: p.name })}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="danger" loading={busy === "remove"} onClick={remove}>
                {tJobs("projects.remove")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                {tJobs("fleet.cancel")}
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-2 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <HardDrive aria-hidden className="size-4 text-ink-muted" />
            {tJobs("projects.worktrees")}
            <span className="font-normal text-ink-muted tabular-nums">
              {wtError ? tJobs("projects.unknownDisk") : wt ? `${wt.worktrees.length} · ${tJobs("projects.disk", { size: bytes(wt.bytes) })}` : "…"}
            </span>
          </p>
          {wt && wt.worktrees.length > 0 && (
            <ul className="grid gap-1 pl-6 text-[0.8125rem] text-ink-muted">
              {wt.worktrees.map((w) => (
                <li key={w.job_id} className="flex flex-wrap items-center gap-x-2">
                  <a href={`/jobs/${w.job_id}`} className="inline-flex min-h-6 items-center font-mono text-accent-strong underline underline-offset-4">
                    {w.branch || `job-${w.job_id}`}
                  </a>
                  <span className="tabular-nums">{bytes(w.bytes)}</span>
                  {w.merged && <span>({tJobs("projects.merged")})</span>}
                </li>
              ))}
            </ul>
          )}
          {wt && wt.worktrees.length === 0 && <p className="pl-6 text-[0.8125rem] text-ink-muted">{tJobs("projects.noWorktrees")}</p>}
          {wt && wt.worktrees.length > 0 && (
            <Button type="button" size="sm" variant="glass" loading={busy === "cleanup"} onClick={cleanup} className="w-fit">
              {tJobs("projects.cleanup")}
            </Button>
          )}
        </div>
        <ProjectAccounts p={p} clis={accounts} onError={setError} />
        {library && <ProjectPacksBlock projectId={p.id} library={library} initial={packs ?? null} />}
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
      </GlassPanel>
    </li>
  );
}

/** M6.5 (ADR 0013): the account each subscription CLI uses in this project ("the agent's choice" = none). */
function ProjectAccounts({ p, clis, onError }: { p: ProjectRow; clis: AccountsResponse["clis"]; onError: (e: string | null) => void }) {
  const { push } = useToast();
  const ids = React.useId();
  const [chosen, setChosen] = React.useState<Record<string, string>>(p.accounts ?? {});
  const many = clis.filter((c) => c.accounts.length > 1);
  if (!many.length) return null;
  const save = async (cli: string, name: string) => {
    const next = { ...chosen };
    if (name) next[cli] = name;
    else delete next[cli];
    onError(null);
    const r = await setProjectAccounts(p.id, next);
    if (!r.ok) return onError(r.error);
    setChosen(r.data.accounts ?? {});
    push({ tone: "success", title: tJobs("fleet.saved_toast") });
  };
  return (
    <div className="grid gap-2 text-sm">
      {many.map((c) => (
        <div key={c.cli} className="grid gap-1">
          <label htmlFor={`${ids}-${c.cli}`} className="font-semibold">
            {`${tSubs("accounts.choose")} · ${c.label}`}
          </label>
          <select
            id={`${ids}-${c.cli}`}
            value={chosen[c.cli] ?? ""}
            onChange={(e) => save(c.cli, e.target.value)}
            className="min-h-(--ctl) w-60 rounded-control border border-hairline bg-glass-strong px-3"
          >
            <option value="">{tSubs("accounts.agentDefault")}</option>
            {c.accounts.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name === "default" ? tSubs("accounts.defaultName") : a.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      <p className="text-[0.8125rem] text-ink-muted">{tSubs("accounts.never")}</p>
    </div>
  );
}

export function ProjectsScreen({
  initial,
  worktrees,
  keep,
  keepDefault,
  accounts = [],
  library = null,
  projectPacks = {},
}: {
  initial: ProjectRow[];
  /** Per project id: its copies (null = hostprobe couldn't say). */
  worktrees: Record<number, ProjectWorktrees | null>;
  keep: number | null;
  keepDefault: number | null;
  /** M6.5: subscription CLIs and their accounts (a choice appears only where there is more than one). */
  accounts?: AccountsResponse["clis"];
  /** M4.5a: the pack library and each project's pack settings. */
  library?: PackRow[] | null;
  projectPacks?: Record<number, ProjectPacks["packs"] | null>;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [projects, setProjects] = React.useState(initial);
  const [path, setPath] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [keepVal, setKeepVal] = React.useState(keep != null ? String(keep) : "");
  const [keepBusy, setKeepBusy] = React.useState(false);
  const [keepError, setKeepError] = React.useState<string | null>(null);
  const ids = React.useId();

  const [seenInitial, setSeenInitial] = React.useState(initial);
  if (seenInitial !== initial) {
    setSeenInitial(initial);
    setProjects(initial);
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await addProject(path);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setPath("");
    setProjects((cur) => (cur.some((p) => p.id === r.data.id) ? cur : [...cur, r.data]));
    push({ tone: "success", title: tJobs("projects.added", { name: r.data.name }) });
    router.refresh();
  };

  const saveKeep = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(keepVal);
    if (!Number.isInteger(n) || n < 0 || n > 100) return setKeepError(tJobs("projects.invalidKeep"));
    setKeepBusy(true);
    setKeepError(null);
    const r = await saveSettings({ keep_worktrees_per_project: n });
    setKeepBusy(false);
    if (!r.ok) return setKeepError(r.error);
    push({ tone: "success", title: tJobs("fleet.saved_toast") });
  };

  return (
    <div className="grid gap-6">
      <GlassPanel as="section" tone="strong" aria-labelledby={`${ids}-add`} className="grid gap-3">
        <h2 id={`${ids}-add`} className="flex items-center gap-2 font-display text-xl font-bold tracking-tight">
          <FolderPlus aria-hidden className="size-5 text-accent-strong" /> {tJobs("projects.add")}
        </h2>
        <form onSubmit={add} className="grid gap-2">
          <label htmlFor={`${ids}-path`} className="text-sm font-semibold">
            {tJobs("projects.path")}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${ids}-path`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={tJobs("projects.pathPlaceholder")}
              aria-describedby={`${ids}-ph ${error ? `${ids}-err` : ""}`}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              className="min-h-(--ctl) min-w-0 flex-1 basis-72 rounded-control border border-hairline bg-glass-strong px-3 font-mono text-sm"
            />
            <Button type="submit" size="sm" loading={busy} disabled={!path.trim()}>
              {tJobs("projects.add")}
            </Button>
          </div>
          <p id={`${ids}-ph`} className="text-[0.8125rem] text-ink-muted">
            {tJobs("projects.pathHelp")}
          </p>
          {error && (
            <p id={`${ids}-err`} role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
        </form>
      </GlassPanel>

      {projects.length === 0 ? (
        <GlassPanel tone="strong">
          <EmptyState title={tJobs("projects.title")} body={tJobs("projects.empty")} icon={<FolderGit2 aria-hidden className="size-6" />} />
        </GlassPanel>
      ) : (
        <ul className="grid gap-4">
          {projects.map((p) => (
            <ProjectItem
              key={p.id}
              p={p}
              accounts={accounts}
              initial={worktrees[p.id]}
              library={library}
              packs={projectPacks[p.id]}
              onRemoved={() => setProjects((cur) => cur.filter((x) => x.id !== p.id))}
            />
          ))}
        </ul>
      )}

      {keep != null && (
        <GlassPanel as="section" tone="strong" aria-labelledby={`${ids}-keep`} className="grid gap-2">
          <h2 id={`${ids}-keep`} className="font-display text-xl font-bold tracking-tight">
            {tJobs("projects.retention")}
          </h2>
          <form onSubmit={saveKeep} className="flex flex-wrap items-end gap-2">
            <label htmlFor={`${ids}-k`} className="sr-only">
              {tJobs("projects.retention")}
            </label>
            <input
              id={`${ids}-k`}
              inputMode="numeric"
              value={keepVal}
              onChange={(e) => setKeepVal(e.target.value)}
              aria-describedby={`${ids}-kh`}
              aria-invalid={keepError ? true : undefined}
              className="min-h-(--ctl) w-24 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
            />
            <Button type="submit" size="sm" loading={keepBusy}>
              {tJobs("hire.save")}
            </Button>
          </form>
          <p id={`${ids}-kh`} className="text-[0.8125rem] text-ink-muted">
            {tJobs("projects.retentionHelp", { n: keepDefault ?? 10 })}
          </p>
          {keepError && (
            <p role="alert" className="text-sm text-err">
              {keepError}
            </p>
          )}
        </GlassPanel>
      )}
    </div>
  );
}
