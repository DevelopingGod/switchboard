"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Dial } from "@/components/kit/Dial";
import { useToast } from "@/components/kit/Toast";
import { editAgent, hireAgent } from "@/app/jobs/actions";
import type { AgentInput, AgentRow, AgentTemplate, ProjectRow } from "@/lib/router-types";
import { jobsStrings, tJobs } from "@/i18n/jobs";

const NAMES = jobsStrings.autonomy.names;

/**
 * Hire an agent from a template (Claude Code, Codex, OpenCode; optional CLIs are listed as not installed
 * or not verified), or edit one (ADR 0009). Level 3 is shown but can't be chosen while no sandbox works.
 */
export default function AgentFormDialog({
  open,
  onOpenChange,
  templates,
  projects,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: AgentTemplate[];
  projects: ProjectRow[];
  agent?: AgentRow;
}) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const editing = !!agent;
  const firstRunnable = templates.find((t) => t.runnable && t.installed) ?? templates.find((t) => t.runnable);
  const [template, setTemplate] = React.useState(agent?.template ?? agent?.id ?? firstRunnable?.id ?? "");
  const tpl = templates.find((t) => t.id === template);
  const [label, setLabel] = React.useState(agent?.label ?? "");
  const [role, setRole] = React.useState(agent?.role ?? "");
  const [model, setModel] = React.useState(agent?.model ?? tpl?.model ?? "");
  const [level, setLevel] = React.useState(agent?.default_autonomy ?? 1);
  const [monthly, setMonthly] = React.useState(agent?.monthly_budget_list_usd != null ? String(agent.monthly_budget_list_usd) : "");
  const [scope, setScope] = React.useState<"all" | "some">(agent?.allowed_project_ids ? "some" : "all");
  const [chosen, setChosen] = React.useState<number[]>(agent?.allowed_project_ids ?? []);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const off: Record<number, string> = {};
  const l3 = (agent?.levels ?? tpl?.levels)?.["3"];
  if (l3) off[3] = l3;
  const models = agent?.models.length ? agent.models : (tpl?.models ?? []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const m = monthly.trim() ? Number(monthly.replace(/^\$/, "")) : null;
    if (m !== null && !(Number.isFinite(m) && m > 0)) return setError(tJobs("hire.monthlyHelp"));
    const body: AgentInput = {
      label,
      role: role.trim() || null,
      model: models.length ? model || null : null,
      default_autonomy: level,
      monthly_list_usd: m,
      allowed_project_ids: scope === "all" ? null : chosen,
    };
    if (!models.length) delete body.model;
    setBusy(true);
    const r = editing ? await editAgent(agent!.id, body) : await hireAgent({ ...body, template });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    push({ tone: "success", title: editing ? tJobs("fleet.saved_toast") : tJobs("fleet.hired_toast", { agent: r.data.label }) });
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={`${ids}-lead`}>
        <DialogTitle className="heading pr-8">{editing ? tJobs("hire.editTitle", { agent: agent!.label }) : tJobs("hire.title")}</DialogTitle>
        <DialogDescription id={`${ids}-lead`} className="text-sm text-ink-muted">
          {tJobs("hire.lead")}
        </DialogDescription>
        <form onSubmit={submit} className="grid gap-4">
          {!editing && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-semibold">{tJobs("hire.template")}</legend>
              {templates.map((t) => {
                const why = !t.runnable ? t.note : !t.installed ? tJobs("fleet.notInstalled") : null;
                return (
                  <label key={t.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`${ids}-tpl`}
                      value={t.id}
                      checked={template === t.id}
                      disabled={!t.runnable}
                      onChange={() => {
                        setTemplate(t.id);
                        setModel(t.model ?? "");
                      }}
                      className="mt-1 accent-[var(--accent-strong)]"
                    />
                    <span className={t.runnable ? "" : "text-ink-muted"}>
                      <span className="font-semibold">{t.label}</span>
                      {why && <span className="block text-[0.8125rem] text-ink-muted">{why}</span>}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          <div className="grid gap-1.5">
            <label htmlFor={`${ids}-name`} className="text-sm font-semibold">
              {tJobs("hire.name")}
            </label>
            <input
              id={`${ids}-name`}
              required
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={tJobs("hire.namePlaceholder")}
              className="min-h-(--ctl) w-full max-w-sm rounded-control border border-hairline bg-glass-strong px-3"
            />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${ids}-role`} className="text-sm font-semibold">
              {tJobs("hire.role")}
            </label>
            <textarea
              id={`${ids}-role`}
              rows={2}
              maxLength={2000}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder={tJobs("hire.rolePlaceholder")}
              aria-describedby={`${ids}-rh`}
              className="w-full rounded-control border border-hairline bg-glass-strong p-3 text-sm"
            />
            <p id={`${ids}-rh`} className="text-[0.8125rem] text-ink-muted">
              {tJobs("hire.roleHelp")}
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${ids}-model`} className="text-sm font-semibold">
              {tJobs("hire.model")}
            </label>
            {models.length ? (
              <select
                id={`${ids}-model`}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="min-h-(--ctl) w-full max-w-sm rounded-control border border-hairline bg-glass-strong px-3"
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <p id={`${ids}-model`} className="text-sm text-ink-muted">
                {tJobs("hire.modelDefault", { template: tpl?.label ?? agent?.label ?? "" })}
              </p>
            )}
          </div>

          <div className="grid items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
            <Dial value={level} stops={NAMES} disabledStops={off} onChange={setLevel} label={tJobs("hire.autonomy")} valueText={`${level}: ${NAMES[level]}`} size={104} />
            <div className="grid gap-1 text-sm">
              <p className="font-semibold">
                {tJobs("hire.autonomy")}: {level} · {NAMES[level]}
              </p>
              <p className="text-ink-muted">{tJobs("hire.autonomyHelp")}</p>
              {off[3] && <p className="text-[0.8125rem] text-ink-muted">{tJobs("autonomy.off", { reason: off[3] })}</p>}
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${ids}-month`} className="text-sm font-semibold">
              {tJobs("hire.monthly")}
            </label>
            <input
              id={`${ids}-month`}
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              aria-describedby={`${ids}-mh`}
              className="min-h-(--ctl) w-36 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
            />
            <p id={`${ids}-mh`} className="text-[0.8125rem] text-ink-muted">
              {tJobs("hire.monthlyHelp")}
            </p>
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-semibold">{tJobs("hire.projects")}</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${ids}-scope`} checked={scope === "all"} onChange={() => setScope("all")} className="accent-[var(--accent-strong)]" />
              {tJobs("hire.allProjects")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${ids}-scope`} checked={scope === "some"} onChange={() => setScope("some")} className="accent-[var(--accent-strong)]" />
              {tJobs("hire.chosenProjects")}
            </label>
            {scope === "some" && (
              <div className="grid gap-1 pl-6">
                {projects.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={chosen.includes(p.id)}
                      onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                      className="accent-[var(--accent-strong)]"
                    />
                    <span className="min-w-0 truncate">{`${p.name} (${p.path})`}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {error && (
            <p role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {tJobs("fleet.cancel")}
            </Button>
            <Button type="submit" size="sm" loading={busy} disabled={!editing && !tpl?.runnable}>
              {editing ? tJobs("hire.save") : tJobs("hire.hireIt")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
