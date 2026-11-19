"use client";

import * as React from "react";
import { Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import type { Overrides, RuleProblem, RulesFile, RulesVocab } from "@/lib/router-types";
import { problemMap, setPath } from "@/lib/rules-model";
import { tRules } from "@/i18n/rules";
import { Field, NumberInput, SelectInput, TextArea, TextInput } from "./fields";

interface Props {
  base: RulesFile;
  effective: RulesFile;
  draft: Overrides;
  vocab: RulesVocab;
  problems: RuleProblem[];
  onDraft: (next: Overrides) => void;
}

const numField = (v: number | undefined, base: number | undefined) => (v === undefined || v === base ? undefined : v);

function Block({ id, title, help, children }: { id: string; title: string; help?: string; children: React.ReactNode }) {
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={`adv-${id}`} className="grid content-start gap-4">
      <header className="grid gap-1">
        <h3 id={`adv-${id}`} className="font-display text-lg font-bold tracking-tight">
          {title}
        </h3>
        {help && <p className="text-sm text-ink-muted">{help}</p>}
      </header>
      {children}
    </GlassPanel>
  );
}

function Slash({ p }: { p: Props }) {
  const [cmd, setCmd] = React.useState("");
  const [rule, setRule] = React.useState("default");
  const probs = problemMap(p.problems);
  const removed = Object.keys(p.base.slash).filter((c) => p.draft.slash?.[c] === null);
  const valid = /^[a-z][a-z0-9_-]{0,19}$/.test(cmd) && !(cmd in p.effective.slash);
  const set = (c: string, v: string | null | undefined) => p.onDraft(setPath(p.draft, ["slash", c], v));
  return (
    <Block id="slash" title={tRules("advanced.slash")} help={tRules("advanced.slashHelp")}>
      <ul className="grid gap-2">
        {Object.entries(p.effective.slash).map(([c, rid]) => (
          <li key={c} className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 font-mono text-sm">/{c}</span>
            <SelectInput
              aria-label={`${tRules("advanced.slashRule")}: /${c}`}
              value={rid}
              className="min-w-0 flex-1"
              aria-invalid={probs.has(`slash.${c}`) || undefined}
              onChange={(e) => set(c, e.target.value === p.base.slash[c] ? undefined : e.target.value)}
            >
              {p.effective.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </SelectInput>
            <Button type="button" size="icon" variant="ghost" aria-label={tRules("advanced.slashRemove", { name: c })} onClick={() => set(c, c in p.base.slash ? null : undefined)}>
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
        {removed.map((c) => (
          <li key={c} className="flex items-center justify-between gap-2 rounded-control border border-dashed border-hairline px-3 py-1.5 text-sm">
            <span className="font-mono">/{c}</span>
            <Button type="button" size="sm" variant="glass" aria-label={tRules("advanced.slashRestore", { name: c })} onClick={() => set(c, undefined)}>
              <Undo2 aria-hidden className="size-4" /> {tRules("rules.form.undoRemove")}
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) {
            set(cmd, rule);
            setCmd("");
          }
        }}
      >
        <Field id="slash-new" label={tRules("advanced.slashCommand")} className="w-32">
          {(a) => <TextInput {...a} value={cmd} placeholder="quick" onChange={(e) => setCmd(e.target.value.toLowerCase().replace(/^\//, ""))} />}
        </Field>
        <Field id="slash-new-rule" label={tRules("advanced.slashRule")} className="min-w-40 flex-1">
          {(a) => (
            <SelectInput {...a} value={rule} onChange={(e) => setRule(e.target.value)}>
              {p.effective.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        <Button type="submit" size="sm" variant="glass" disabled={!valid}>
          <Plus aria-hidden className="size-4" /> {tRules("advanced.slashAdd")}
        </Button>
      </form>
    </Block>
  );
}

function Classifier({ p }: { p: Props }) {
  const probs = problemMap(p.problems);
  return (
    <Block id="classifier" title={tRules("advanced.classifier")} help={tRules("advanced.classifierHelp")}>
      <Field id="cls-timeout" label={tRules("advanced.timeout")} problem={probs.get("")} className="max-w-xs">
        {(a) => (
          <NumberInput {...a} value={p.effective.classifier.timeout_s} step={0.1} min={0.1} max={30} onChange={(v) => p.onDraft(setPath(p.draft, ["classifier", "timeout_s"], numField(v, p.base.classifier.timeout_s)))} />
        )}
      </Field>
      <ul className="grid gap-4">
        {p.effective.classifier.routes.map((r) => {
          const original = p.base.classifier.routes.find((x) => x.name === r.name)?.description;
          const edited = original !== undefined && original !== r.description;
          const sensitive = "sensitive" in r.facts;
          const path = `classifier.routes.${r.name}.description`;
          return (
            <li key={r.name} className="grid gap-1.5">
              <Field id={`cls-${r.name}`} label={tRules("advanced.routeDescription", { name: r.name })} problem={probs.get(path)} help={`${tRules("advanced.routeFacts", { facts: Object.entries(r.facts).map(([k, v]) => `${k}: ${v}`).join(", ") })}${sensitive ? ` · ${tRules("advanced.sensitiveNote")}` : ""}`}>
                {(a) => (
                  <TextArea
                    {...a}
                    value={r.description}
                    maxLength={p.vocab.limits.max_text}
                    onChange={(e) => p.onDraft(setPath(p.draft, ["classifier", "routes", r.name, "description"], e.target.value === original ? undefined : e.target.value))}
                  />
                )}
              </Field>
              {edited && (
                <Button type="button" size="sm" variant="glass" className="justify-self-start" onClick={() => p.onDraft(setPath(p.draft, ["classifier", "routes", r.name], undefined))}>
                  <RotateCcw aria-hidden className="size-4" /> {tRules("advanced.routeReset")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

function Numbers({ p }: { p: Props }) {
  const probs = problemMap(p.problems);
  const w = p.effective.recommender.weights;
  const num = (block: "quota" | "summary" | "defaults", key: string, label: string, step: number, min: number, max: number) => {
    const eff = (p.effective[block] as Record<string, number | boolean>)[key] as number | undefined;
    const base = (p.base[block] as Record<string, number | boolean>)[key] as number | undefined;
    return (
      <Field key={`${block}-${key}`} id={`n-${block}-${key}`} label={label} problem={probs.get(`${block}.${key}`)}>
        {(a) => <NumberInput {...a} value={eff} step={step} min={min} max={max} onChange={(v) => p.onDraft(setPath(p.draft, [block, key], numField(v, base)))} />}
      </Field>
    );
  };
  return (
    <>
      <Block id="defaults" title={tRules("advanced.defaults")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("defaults", "temperature", tRules("advanced.defaultsTemperature"), 0.1, 0, 2)}
          {num("defaults", "autonomy", tRules("advanced.defaultsAutonomy"), 1, 0, 3)}
          {num("defaults", "max_cost_usd", tRules("advanced.defaultsMaxCost"), 0.01, 0, 100)}
          {num("defaults", "daily_cap_usd", tRules("advanced.defaultsDaily"), 0.1, 0, 100)}
        </div>
      </Block>
      <Block id="quota" title={tRules("advanced.quota")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("quota", "reroute_at", tRules("advanced.quotaReroute"), 0.05, 0.05, 1.5)}
          {num("quota", "block_at", tRules("advanced.quotaBlock"), 0.05, 0.05, 1.5)}
        </div>
      </Block>
      <Block id="summary" title={tRules("advanced.summary")}>
        <div className="grid gap-3 sm:grid-cols-2">
          {num("summary", "start_at", tRules("advanced.summaryStart"), 0.05, 0.2, 1)}
          {num("summary", "keep_last", tRules("advanced.summaryKeep"), 1, 2, 50)}
        </div>
      </Block>
      <Block id="weights" title={tRules("advanced.recommender")} help={tRules("advanced.recommenderHelp")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.keys(w).map((k) => (
            <Field key={k} id={`n-w-${k}`} label={tRules(`test.factors.${k}` as never) || k} problem={probs.get(`recommender.weights.${k}`)}>
              {(a) => (
                <NumberInput
                  {...a}
                  value={w[k]}
                  step={0.05}
                  min={0}
                  max={1}
                  onChange={(v) => p.onDraft(setPath(p.draft, ["recommender", "weights", k], numField(v, p.base.recommender.weights[k])))}
                />
              )}
            </Field>
          ))}
        </div>
      </Block>
    </>
  );
}

export default function AdvancedPanel(p: Props) {
  return (
    <div className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] items-start">
      <Slash p={p} />
      <Classifier p={p} />
      <Numbers p={p} />
    </div>
  );
}
