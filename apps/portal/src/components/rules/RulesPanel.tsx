"use client";

import * as React from "react";
import { Lock, Pencil, Plus, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ExplainPopover } from "@/components/kit/ExplainPopover";
import type { Overrides, RuleDef, RuleProblem, RulesFile, RulesVocab } from "@/lib/router-types";
import {
  addRule, disableRule, isDisabled, isEdited, isNewRule, problemMap, problemsUnder, resetRule, setRuleField, targetLabel, whenSummary,
} from "@/lib/rules-model";
import { cn } from "@/lib/cn";
import { tRules } from "@/i18n/rules";
import { ChainEditor } from "./ChainEditor";
import { Check, Field, NumberInput, SelectInput, TextInput } from "./fields";

interface Props {
  base: RulesFile;
  effective: RulesFile;
  draft: Overrides;
  vocab: RulesVocab;
  problems: RuleProblem[];
  onDraft: (next: Overrides) => void;
}

const WHEN_FIELDS = ["intent", "size", "quality"] as const;
const WHEN_OPTIONS: Record<(typeof WHEN_FIELDS)[number], string[]> = { intent: [], size: ["small", "large"], quality: ["normal", "high"] };

/** The "Applies when" editor: kind, size, quality, slash command, private. */
function WhenEditor({ idPrefix, when, vocab, locked, problem, onChange }: { idPrefix: string; when: NonNullable<RuleDef["when"]>; vocab: RulesVocab; locked: boolean; problem?: string; onChange: (w: NonNullable<RuleDef["when"]>) => void }) {
  const set = (k: string, v: string | boolean | undefined) => {
    const next = { ...when };
    if (v === undefined || v === "" || v === false) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2">
      <legend className="pb-1 text-sm font-semibold">{tRules("rules.form.when")}</legend>
      {problem && <p className="text-[0.8125rem] font-semibold text-err sm:col-span-2">{problem}</p>}
      {WHEN_FIELDS.map((k) => (
        <Field key={k} id={`${idPrefix}-when-${k}`} label={tRules(`rules.form.${k}`)}>
          {(a) => (
            <SelectInput {...a} value={(when[k] as string) ?? ""} onChange={(e) => set(k, e.target.value)}>
              <option value="">{tRules("rules.form.any")}</option>
              {(k === "intent" ? vocab.intents : WHEN_OPTIONS[k]).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
      ))}
      <Field id={`${idPrefix}-when-command`} label={tRules("rules.form.command")}>
        {(a) => <TextInput {...a} value={(when.command as string) ?? ""} placeholder="bulk" onChange={(e) => set("command", e.target.value.trim().replace(/^\//, ""))} />}
      </Field>
      <div className="sm:col-span-2">
        <Check id={`${idPrefix}-when-private`} checked={when.private === true} onChange={(v) => set("private", v)}>
          {tRules("rules.form.private")}
        </Check>
      </div>
    </fieldset>
  );
}

function RuleForm({ id, p, onClose }: { id: string; p: Props; onClose: () => void }) {
  const { base, effective, draft, vocab, problems, onDraft } = p;
  const rule = effective.rules.find((r) => r.id === id);
  const isNew = isNewRule(base, id);
  const protectedRule = vocab.protected_rules.includes(id);
  const priv = id === "private";
  const mine = problems.filter((x) => x.path === `rules.${id}` || x.path.startsWith(`rules.${id}.`));
  const byField = React.useMemo(() => {
    const m = problemMap(problemsUnder(problems, `rules.${id}`).map((x) => ({ ...x, path: x.path.replace(`rules.${id}.`, "") })));
    return m;
  }, [problems, id]);
  if (!rule) return null;
  const set = (field: Parameters<typeof setRuleField>[3], v: unknown) => onDraft(setRuleField(draft, base, id, field, v));
  const fid = `rf-${id}`;
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={`${fid}-title`} className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${fid}-title`} className="font-display text-lg font-bold tracking-tight">
          {tRules("rules.form.title", { id })}
        </h3>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          <X aria-hidden className="size-4" /> {tRules("rules.form.close")}
        </Button>
      </header>
      {priv && (
        <p className="flex items-start gap-2 rounded-control border border-hairline bg-glass p-3 text-sm">
          <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-strong" /> {tRules("rules.form.lockedNote")}
        </p>
      )}
      {mine.length > 0 && byField.size === 0 && <p role="alert" className="text-sm font-semibold text-err">{mine[0].message}</p>}
      <WhenEditor idPrefix={fid} when={rule.when ?? {}} vocab={vocab} locked={priv} problem={byField.get("when")} onChange={(w) => set("when", w)} />
      <ChainEditor
        idPrefix={fid}
        target={rule.target}
        fallbacks={rule.fallbacks ?? []}
        vocab={vocab}
        problems={byField}
        localOnly={priv}
        onChange={(t, fb) => onDraft(setRuleField(setRuleField(draft, base, id, "target", t), base, id, "fallbacks", fb))}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={`${fid}-temp`} label={tRules("rules.form.temperature")} problem={byField.get("temperature")}>
          {(a) => <NumberInput {...a} value={rule.temperature} step={0.1} min={0} max={2} onChange={(v) => set("temperature", v)} />}
        </Field>
        <Field id={`${fid}-auto`} label={tRules("rules.form.autonomy")} problem={byField.get("autonomy")}>
          {(a) => <NumberInput {...a} value={rule.autonomy} step={1} min={0} max={3} onChange={(v) => set("autonomy", v)} />}
        </Field>
        <Field id={`${fid}-cost`} label={tRules("rules.form.maxCost")} problem={byField.get("max_cost_usd")}>
          {(a) => <NumberInput {...a} value={rule.max_cost_usd} step={0.01} min={0} max={100} onChange={(v) => set("max_cost_usd", v)} />}
        </Field>
      </div>
      {!priv && (
        <Check id={`${fid}-job`} checked={rule.job === true} onChange={(v) => set("job", v ? true : undefined)}>
          {tRules("rules.form.job")}
        </Check>
      )}
      {isNew && <PositionField id={id} p={p} />}
      <footer className="flex flex-wrap gap-2 border-t border-hairline pt-4">
        {!isNew && isEdited(draft, id) && (
          <Button type="button" size="sm" variant="glass" onClick={() => onDraft(resetRule(draft, id))}>
            <RotateCcw aria-hidden className="size-4" /> {tRules("rules.form.reset")}
          </Button>
        )}
        {isNew ? (
          <Button type="button" size="sm" variant="danger" onClick={() => (onDraft(resetRule(draft, id)), onClose())}>
            <Trash2 aria-hidden className="size-4" /> {tRules("rules.form.deleteNew")}
          </Button>
        ) : protectedRule ? (
          <span className="self-center text-[0.8125rem] text-ink-muted">{tRules("rules.form.removeLocked")}</span>
        ) : (
          <Button type="button" size="sm" variant="danger" onClick={() => (onDraft(disableRule(draft, id)), onClose())}>
            <Trash2 aria-hidden className="size-4" /> {tRules("rules.form.remove")}
          </Button>
        )}
      </footer>
    </GlassPanel>
  );
}

/** Where a new rule sits in the order. */
function PositionField({ id, p }: { id: string; p: Props }) {
  const ids = p.effective.rules.map((r) => r.id).filter((x) => x !== id);
  const cur = p.draft.rules?.[id]?.before ?? "";
  return (
    <Field id={`rf-${id}-before`} label={tRules("rules.addBefore")}>
      {(a) => (
        <SelectInput {...a} value={cur} onChange={(e) => p.onDraft({ ...p.draft, rules: { ...p.draft.rules, [id]: { ...p.draft.rules![id], before: e.target.value || undefined } } })}>
          <option value="">{tRules("rules.addBeforeDefault")}</option>
          {ids.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </SelectInput>
      )}
    </Field>
  );
}

function AddRule({ p, onAdded }: { p: Props; onAdded: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const taken = p.effective.rules.some((r) => r.id === name) || isDisabled(p.draft, name);
  const valid = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) && !taken;
  if (!open)
    return (
      <Button type="button" size="sm" variant="glass" onClick={() => setOpen(true)} className="justify-self-start">
        <Plus aria-hidden className="size-4" /> {tRules("rules.add")}
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        p.onDraft(addRule(p.draft, name, { when: { intent: "chat" }, target: "model:fast", fallbacks: ["model:local"] }));
        setOpen(false);
        setName("");
        onAdded(name);
      }}
    >
      <Field id="add-rule-id" label={tRules("rules.addId")} help={tRules("rules.addIdHelp")} problem={name && !valid ? tRules("field.invalid") : undefined} className="min-w-48 flex-1">
        {(a) => <TextInput {...a} autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />}
      </Field>
      <Button type="submit" size="sm" disabled={!valid}>
        {tRules("rules.addCreate")}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        {tRules("rules.form.close")}
      </Button>
    </form>
  );
}

export default function RulesPanel(p: Props) {
  const [open, setOpen] = React.useState<string | null>(null);
  const removed = p.base.rules.filter((r) => isDisabled(p.draft, r.id));
  return (
    <div className="grid gap-4">
      <GlassPanel as="section" tone="strong" aria-labelledby="rules-h" className="grid gap-4">
        <header className="flex items-center gap-1.5">
          <h2 id="rules-h" className="font-display text-xl font-bold tracking-tight">
            {tRules("rules.heading")}
          </h2>
          <ExplainPopover topic={tRules("rules.heading")} title={tRules("rules.heading")}>
            {tRules("rules.help")}
          </ExplainPopover>
        </header>
        {/* Container queries, not viewport ones: the sidebar takes 17 rem of the window. The table always
            fits its box (no sideways scroll); narrow boxes drop the Order and When columns and show the
            condition under the rule name instead. */}
        <div className="@container">
          <table className="w-full border-separate border-spacing-y-1 text-left text-sm">
            <caption className="sr-only">{tRules("rules.help")}</caption>
            <thead>
              <tr className="label text-[0.625rem]">
                <th scope="col" className="hidden w-10 px-2 font-semibold @lg:table-cell">{tRules("rules.colOrder")}</th>
                <th scope="col" className="px-2 font-semibold">{tRules("rules.colRule")}</th>
                <th scope="col" className="hidden px-2 font-semibold @xl:table-cell">{tRules("rules.colWhen")}</th>
                <th scope="col" className="px-2 font-semibold">{tRules("rules.colTarget")}</th>
                <th scope="col" className="w-px px-2"><span className="sr-only">{tRules("rules.edit")}</span></th>
              </tr>
            </thead>
            <tbody>
              {p.effective.rules.map((r, i) => {
                const bad = problemsUnder(p.problems, `rules.${r.id}`).length > 0;
                return (
                  <tr key={r.id} className={cn("bg-glass", open === r.id && "ring-2 ring-accent-strong", bad && "ring-2 ring-err")}>
                    <td className="hidden rounded-l-control px-2 py-2.5 tabular-nums text-ink-muted @lg:table-cell">{i + 1}</td>
                    <th scope="row" className="px-2 py-2.5 font-semibold max-@lg:rounded-l-control">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {r.id === "private" && <Lock aria-label={tRules("rules.badge.locked")} className="size-3.5 text-accent-strong" />}
                        {r.id}
                        {isNewRule(p.base, r.id) ? <Badge>{tRules("rules.badge.new")}</Badge> : isEdited(p.draft, r.id) && <Badge>{tRules("rules.badge.edited")}</Badge>}
                        {r.job && <Badge quiet>{tRules("rules.badge.job")}</Badge>}
                      </span>
                      <span className="block text-[0.8125rem] font-normal text-ink-muted @xl:hidden">{whenSummary(r.when)}</span>
                    </th>
                    <td className="hidden px-2 py-2.5 text-ink-muted @xl:table-cell">{whenSummary(r.when)}</td>
                    <td className="px-2 py-2.5">
                      <span className="font-medium">{targetLabel(r.target)}</span>{" "}
                      <span className="text-[0.8125rem] text-ink-muted">
                        {(r.fallbacks?.length ?? 0) > 0 ? tRules("rules.fallbacks", { count: r.fallbacks!.length }) : tRules("rules.noFallbacks")}
                      </span>
                    </td>
                    <td className="rounded-r-control px-2 py-1.5 text-right whitespace-nowrap">
                      <Button type="button" size="sm" variant={open === r.id ? "primary" : "glass"} aria-expanded={open === r.id} aria-controls={`rf-${r.id}-title`} aria-label={`${open === r.id ? tRules("rules.editing") : tRules("rules.edit")} ${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                        <Pencil aria-hidden className="size-3.5" /> {open === r.id ? tRules("rules.editing") : tRules("rules.edit")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {removed.length > 0 && (
          <ul className="grid gap-1.5 text-sm" aria-label={tRules("rules.badge.removed")}>
            {removed.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-control border border-dashed border-hairline px-3 py-1.5">
                <span><Badge>{tRules("rules.badge.removed")}</Badge> <span className="font-semibold">{r.id}</span></span>
                <Button type="button" size="sm" variant="glass" onClick={() => p.onDraft(resetRule(p.draft, r.id))}>
                  <Undo2 aria-hidden className="size-4" /> {tRules("rules.form.undoRemove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AddRule p={p} onAdded={setOpen} />
      </GlassPanel>
      {open && p.effective.rules.some((r) => r.id === open) && <RuleForm key={open} id={open} p={p} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Badge({ children, quiet }: { children: React.ReactNode; quiet?: boolean }) {
  return (
    <span className={cn("rounded-chip px-2 py-0.5 text-[0.6875rem] font-bold", quiet ? "border border-hairline text-ink-muted" : "bg-accent-soft text-accent-strong")}>{children}</span>
  );
}
