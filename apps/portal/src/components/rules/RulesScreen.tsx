"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { useToast } from "@/components/kit/Toast";
import { PageActions } from "@/components/shell/PageHeader";
import { saveOnboarding } from "@/app/welcome/actions";
import { reloadRules, saveRules, validateRules } from "@/app/settings/rules/actions";
import { usePrefs } from "@/lib/prefs";
import type { Overrides, Preset, RuleProblem, RulesResponse, RulesVersionsResponse } from "@/lib/router-types";
import { countChanges, hasChanges, mergeOverrides, unsavedCount } from "@/lib/rules-model";
import { cn } from "@/lib/cn";
import { tRules } from "@/i18n/rules";
import { Field, TextInput } from "./fields";

// Every panel is its own chunk, so the route's first-load JS stays small (budget: ADR 0003).
const Skeleton = () => <div aria-hidden className="shimmer h-64 rounded-panel" />;
const PresetsPanel = dynamic(() => import("./PresetsPanel"), { ssr: false, loading: Skeleton });
const RulesPanel = dynamic(() => import("./RulesPanel"), { ssr: false, loading: Skeleton });
const AdvancedPanel = dynamic(() => import("./AdvancedPanel"), { ssr: false, loading: Skeleton });
const HistoryPanel = dynamic(() => import("./HistoryPanel"), { ssr: false, loading: Skeleton });
const DryRunPanel = dynamic(() => import("./DryRunPanel"), { ssr: false, loading: Skeleton });

type Tab = "presets" | "rules" | "advanced" | "history";
const TABS: Tab[] = ["presets", "rules", "advanced", "history"];
const VALIDATE_DELAY_MS = 400;

export function RulesScreen({ initial, versions }: { initial: RulesResponse; versions: RulesVersionsResponse }) {
  const { push } = useToast();
  const pro = usePrefs().mode === "pro";
  const [saved, setSaved] = React.useState(initial);
  const [hist, setHist] = React.useState(versions);
  const [draft, setDraft] = React.useState<Overrides>(initial.overrides);
  const [problems, setProblems] = React.useState<RuleProblem[]>([]);
  const [tab, setTab] = React.useState<Tab>("presets");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [preset, setPreset] = React.useState<Preset>(initial.active_preset);
  const [presetBusy, setPresetBusy] = React.useState(false);

  const dirty = hasChanges(draft, saved.overrides);
  const changes = unsavedCount(draft, saved.overrides);
  const anyEdits = countChanges(draft) > 0;
  // Simple mode shows the presets only; a stored Pro tab falls back to it.
  const shown: Tab = pro ? tab : "presets";
  const effective = React.useMemo(() => mergeOverrides(saved.base, draft), [saved.base, draft]);

  // Live validation: ask the router (the one source of truth) shortly after the last edit.
  const seq = React.useRef(0);
  React.useEffect(() => {
    if (!dirty) return;
    const mine = ++seq.current;
    const id = window.setTimeout(async () => {
      const r = await validateRules(draft);
      if (mine === seq.current && r.ok) setProblems(r.data.problems);
    }, VALIDATE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [draft, dirty]);

  const edit = (next: Overrides) => {
    setStale(false);
    if (!hasChanges(next, saved.overrides)) setProblems([]);
    setDraft(next);
  };

  const refresh = async (keepDraft: boolean) => {
    const [r, h] = await Promise.all([reloadRules(), import("@/app/settings/rules/actions").then((m) => m.loadVersions(null))]);
    if (r.ok) {
      setSaved(r.data);
      if (!keepDraft) setDraft(r.data.overrides);
    } else push({ tone: "error", title: r.error });
    if (h.ok) setHist(h.data);
  };

  const save = async () => {
    setBusy(true);
    const r = await saveRules(draft, note, saved.version?.id ?? null);
    setBusy(false);
    if (!r.ok) {
      if (r.problems?.length) setProblems(r.problems);
      else if (r.code === "rules_stale") setStale(true);
      push({ tone: "error", title: r.code === "rules_stale" ? tRules("bar.stale") : r.error });
      return;
    }
    setProblems([]);
    setNote("");
    push({ tone: "success", title: r.data.created && r.data.version ? tRules("bar.saved", { id: r.data.version.id }) : tRules("bar.nothing") });
    await refresh(false);
  };

  const activate = async (p: Preset) => {
    setPresetBusy(true);
    const r = await saveOnboarding({ preset: p });
    setPresetBusy(false);
    if (!r.ok) return push({ tone: "error", title: r.error });
    setPreset(p);
    push({ tone: "success", title: tRules("presets.changed", { name: p }) });
  };

  const common = { base: saved.base, effective, draft, vocab: saved.vocab, problems, onDraft: edit };
  const blocked = problems.length > 0;

  return (
    <div className="grid gap-6">
      {saved.problems.length > 0 && !dirty && (
        <GlassPanel as="section" tone="strong" role="alert" className="grid gap-2 border border-err">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <AlertTriangle aria-hidden className="size-5 text-err" /> {tRules("stale.title")}
          </h2>
          <p className="text-sm">{tRules("stale.body")}</p>
          <ul className="list-disc pl-5 text-sm text-ink-muted">
            {saved.problems.slice(0, 5).map((p) => (
              <li key={p.path + p.message}>{p.message}</li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {!pro && <p className="max-w-3xl text-sm text-ink-muted">{tRules("mode.simple")}</p>}

      <PageActions>
        {dirty && (
          <Button type="button" size="sm" variant="ghost" onClick={() => (setDraft(saved.overrides), setProblems([]))}>
            {tRules("bar.discard")}
          </Button>
        )}
        <Button type="button" size="sm" disabled={!dirty || busy || blocked} onClick={save}>
          {busy ? tRules("bar.saving") : tRules("bar.save")}
        </Button>
      </PageActions>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="grid min-w-0 gap-4">
          {pro && (
            <div role="tablist" aria-label={tRules("tabs.label")} className="inline-flex flex-wrap gap-1 justify-self-start rounded-chip border border-hairline bg-glass p-1">
              {TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="rules-panel"
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  onKeyDown={(e) => {
                    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    const next = TABS[(TABS.indexOf(id) + d + TABS.length) % TABS.length];
                    setTab(next);
                    document.getElementById(`tab-${next}`)?.focus();
                  }}
                  className={cn("min-h-9 rounded-chip px-4 text-sm font-semibold", tab === id ? "bg-pill-active font-bold ring-1 ring-accent-strong/40" : "text-ink-muted hover:text-ink")}
                >
                  {tRules(`tabs.${id}`)}
                </button>
              ))}
            </div>
          )}

          <div id="rules-panel" role={pro ? "tabpanel" : undefined} aria-labelledby={pro ? `tab-${shown}` : undefined} className="grid min-w-0 gap-4">
            {shown === "presets" && <PresetsPanel {...common} active={preset} pro={pro} busy={presetBusy} onActivate={activate} />}
            {shown === "rules" && <RulesPanel {...common} />}
            {shown === "advanced" && <AdvancedPanel {...common} />}
            {shown === "history" && (
              <HistoryPanel key={saved.version?.id ?? 0} initial={hist.versions} next={hist.next_before} currentId={saved.version?.id ?? null} onRolledBack={() => void refresh(false)} />
            )}
          </div>

          <GlassPanel as="section" tone="strong" aria-label={tRules("bar.save")} className="sticky bottom-3 z-10 grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <p role="status" className="min-w-40 flex-1 text-sm font-semibold">
                {changes === 0 ? tRules("bar.clean") : changes === 1 ? tRules("bar.unsavedOne") : tRules("bar.unsaved", { count: changes })}
                {blocked && <span className="block text-err">{tRules("bar.invalid")}</span>}
                {stale && (
                  <span className="block text-err">
                    {tRules("bar.stale")}{" "}
                    <button type="button" className="underline underline-offset-4" onClick={() => void refresh(true).then(() => setStale(false))}>
                      {tRules("bar.reload")}
                    </button>
                  </span>
                )}
              </p>
              {dirty && (
                <Field id="rules-note" label={tRules("bar.note")} className="min-w-52 flex-[2]">
                  {(a) => <TextInput {...a} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />}
                </Field>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {dirty && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => (setDraft(saved.overrides), setProblems([]))}>
                    {tRules("bar.discard")}
                  </Button>
                )}
                {anyEdits && !confirmReset && (
                  <Button type="button" size="sm" variant="glass" onClick={() => setConfirmReset(true)}>
                    <RotateCcw aria-hidden className="size-4" /> {tRules("bar.resetAll")}
                  </Button>
                )}
                <Button type="button" disabled={!dirty || busy || blocked} onClick={save}>
                  {busy ? tRules("bar.saving") : tRules("bar.save")}
                </Button>
              </div>
            </div>
            {confirmReset && (
              <div role="group" aria-label={tRules("bar.resetConfirm")} className="flex flex-wrap items-center gap-2 rounded-control border border-err p-2 text-sm">
                <span className="font-semibold">{tRules("bar.resetConfirm")}</span>
                <Button type="button" size="sm" variant="danger" autoFocus onClick={() => (edit({}), setConfirmReset(false))}>
                  {tRules("bar.resetYes")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  {tRules("bar.discard")}
                </Button>
              </div>
            )}
          </GlassPanel>
        </div>

        <div className="min-w-0 xl:sticky xl:top-20">
          <DryRunPanel draft={draft} dirty={dirty} pro={pro} blocked={blocked} />
        </div>
      </div>
    </div>
  );
}
