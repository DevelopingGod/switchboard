"use client";

import * as React from "react";
import { Check as CheckIcon, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ExplainPopover } from "@/components/kit/ExplainPopover";
import { Segmented } from "@/components/kit/Segmented";
import type { Overrides, Preset, RuleProblem, RulesFile, RulesVocab } from "@/lib/router-types";
import { chainOf, problemMap, problemsUnder, setPath, targetLabel } from "@/lib/rules-model";
import { cn } from "@/lib/cn";
import { tRules, type RulesKey } from "@/i18n/rules";
import { ChainEditor } from "./ChainEditor";
import { Field, SelectInput } from "./fields";

type Paid = "never" | "manual" | "allowed";

interface Props {
  base: RulesFile;
  effective: RulesFile;
  draft: Overrides;
  vocab: RulesVocab;
  problems: RuleProblem[];
  active: Preset;
  pro: boolean;
  busy: boolean;
  onActivate: (p: Preset) => void;
  onDraft: (next: Overrides) => void;
}

const known = (n: string): n is "free" | "balanced" | "best" => n === "free" || n === "balanced" || n === "best";

function PresetCard({ name, p }: { name: string; p: Props }) {
  const spec = p.effective.presets[name] ?? {};
  const baseSpec = p.base.presets[name] ?? {};
  const isActive = p.active === name;
  const overlay = Object.entries(spec.rules ?? {});
  const label = known(name) ? tRules(`presets.${name}.name` as RulesKey) : name;
  const addable = p.effective.rules.filter((r) => r.id !== "private" && !(r.id in (spec.rules ?? {})));
  const [picking, setPicking] = React.useState("");

  const setOverlay = (rid: string, target: string, fallbacks: string[]) => {
    const b = baseSpec.rules?.[rid];
    const same = b && b.target === target && JSON.stringify(b.fallbacks ?? []) === JSON.stringify(fallbacks);
    p.onDraft(setPath(p.draft, ["presets", name, "rules", rid], same ? undefined : { target, fallbacks }));
  };

  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={`pc-${name}`} className={cn("grid content-start gap-4", isActive && "ring-2 ring-accent-strong")}>
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`pc-${name}`} className="font-display text-lg font-bold tracking-tight">
            {label}
          </h3>
          {isActive ? (
            <span className="inline-flex items-center gap-1 rounded-chip bg-accent-soft px-2.5 py-1 text-[0.75rem] font-bold text-accent-strong">
              <CheckIcon aria-hidden className="size-3.5" /> {tRules("presets.active")}
            </span>
          ) : (
            <Button type="button" size="sm" variant="glass" disabled={p.busy} onClick={() => p.onActivate(name as Preset)} aria-label={`${tRules("presets.use")}: ${label}`}>
              {tRules("presets.use")}
            </Button>
          )}
        </div>
        {known(name) && <p className="text-sm text-ink-muted">{tRules(`presets.${name}.tag` as RulesKey)}</p>}
      </header>

      <div className="grid gap-1.5">
        <span id={`paid-${name}`} className="text-sm font-semibold">
          {tRules("presets.paid")}
        </span>
        <Segmented<Paid>
          label={tRules("presets.paidLabel", { name: label })}
          value={(spec.paid ?? "manual") as Paid}
          onChange={(v) => p.onDraft(setPath(p.draft, ["presets", name, "paid"], v === baseSpec.paid || (v === "manual" && !baseSpec.paid) ? undefined : v))}
          options={(["never", "manual", "allowed"] as const).map((v) => ({ value: v, label: tRules(`presets.paidValue.${v}`) }))}
          className="flex-wrap"
        />
      </div>

      <div className="grid gap-1.5">
        <h4 className="text-sm font-semibold">{tRules("presets.changes")}</h4>
        {overlay.length === 0 ? (
          <p className="text-sm text-ink-muted">{tRules("presets.noChanges")}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {overlay.map(([rid, o]) => (
              <li key={rid} className="rounded-control bg-glass px-3 py-1.5">
                {tRules("presets.changesRule", { rule: rid, chain: chainOf({ target: o.target ?? p.effective.rules.find((r) => r.id === rid)?.target ?? "", fallbacks: o.fallbacks }).map(targetLabel).join(" → ") })}
              </li>
            ))}
          </ul>
        )}
      </div>

      {p.pro && (
        <details className="grid gap-3 rounded-control border border-hairline p-3">
          <summary className="cursor-pointer text-sm font-semibold">{tRules("presets.edit")}</summary>
          <div className="mt-3 grid gap-4">
            {overlay.map(([rid, o]) => {
              const base0 = p.effective.rules.find((r) => r.id === rid);
              const probs = problemMap(problemsUnder(p.problems, `presets.${name}.rules.${rid}`).map((x) => ({ ...x, path: x.path.replace(`presets.${name}.rules.${rid}.`, "") })));
              const inBase = !!baseSpec.rules?.[rid];
              return (
                <fieldset key={rid} className="grid gap-3 rounded-control bg-glass p-3">
                  <legend className="px-1 text-sm font-bold">{rid}</legend>
                  <ChainEditor
                    idPrefix={`pp-${name}-${rid}`}
                    target={o.target ?? base0?.target ?? "model:fast"}
                    fallbacks={o.fallbacks ?? base0?.fallbacks ?? []}
                    vocab={p.vocab}
                    problems={probs}
                    onChange={(t, fb) => setOverlay(rid, t, fb)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="glass"
                    className="justify-self-start"
                    disabled={inBase && !p.draft.presets?.[name]?.rules?.[rid]}
                    onClick={() => p.onDraft(setPath(p.draft, ["presets", name, "rules", rid], undefined))}
                  >
                    {inBase ? <RotateCcw aria-hidden className="size-4" /> : <X aria-hidden className="size-4" />}
                    {inBase ? tRules("rules.form.reset") : tRules("presets.removeOverride")}
                  </Button>
                </fieldset>
              );
            })}
            <Field id={`pp-add-${name}`} label={tRules("presets.addOverride")}>
              {(a) => (
                <SelectInput
                  {...a}
                  value={picking}
                  onChange={(e) => {
                    const r = p.effective.rules.find((x) => x.id === e.target.value);
                    setPicking("");
                    if (r) setOverlay(r.id, r.target, r.fallbacks ?? []);
                  }}
                >
                  <option value="">{tRules("presets.pickRule")}</option>
                  {addable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>
          </div>
        </details>
      )}
    </GlassPanel>
  );
}

export default function PresetsPanel(p: Props) {
  const names = [...new Set([...p.vocab.presets, ...Object.keys(p.effective.presets)])];
  return (
    <section aria-labelledby="presets-h" className="grid gap-4">
      <header className="flex items-center gap-1.5">
        <h2 id="presets-h" className="font-display text-xl font-bold tracking-tight">
          {tRules("presets.heading")}
        </h2>
        <ExplainPopover topic={tRules("presets.heading")} title={tRules("presets.heading")}>
          {tRules("presets.help")}
        </ExplainPopover>
      </header>
      <div className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))]">
        {names.map((n) => (
          <PresetCard key={n} name={n} p={p} />
        ))}
      </div>
    </section>
  );
}
