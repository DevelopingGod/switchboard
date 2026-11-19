"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RulesVocab } from "@/lib/router-types";
import { targetLabel } from "@/lib/rules-model";
import { tRules } from "@/i18n/rules";
import { Field, SelectInput, TextInput } from "./fields";

const CUSTOM = "__custom__";

/** One target: a model alias, best:<capability>, the current value, or free text for anything else. */
export function TargetPicker({
  id,
  label,
  help,
  value,
  vocab,
  problem,
  onChange,
  localOnly,
}: {
  id: string;
  label: string;
  help?: string;
  value: string;
  vocab: RulesVocab;
  problem?: string;
  onChange: (v: string) => void;
  /** The private rule: local models only (the router enforces it too). */
  localOnly?: boolean;
}) {
  const aliases = localOnly ? ["local", "private", "local-code"] : vocab.aliases;
  const known = new Set([...aliases.map((a) => `model:${a}`), ...(localOnly ? [] : vocab.capabilities.map((c) => `best:${c}`))]);
  const [custom, setCustom] = React.useState(false);
  const showCustom = custom;
  return (
    <div className="grid gap-1.5">
      <Field label={label} id={id} help={help} problem={problem}>
        {(a) => (
          <SelectInput
            {...a}
            value={showCustom ? CUSTOM : value}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustom(true);
              else {
                setCustom(false);
                onChange(e.target.value);
              }
            }}
          >
            {!known.has(value) && !showCustom && <option value={value}>{targetLabel(value)} (current)</option>}
            <optgroup label="Models">
              {aliases.map((al) => (
                <option key={al} value={`model:${al}`}>
                  {al}
                </option>
              ))}
            </optgroup>
            {!localOnly && (
              <optgroup label="Best for…">
                {vocab.capabilities.map((c) => (
                  <option key={c} value={`best:${c}`}>
                    best for {c}
                  </option>
                ))}
              </optgroup>
            )}
            {!localOnly && <option value={CUSTOM}>{tRules("rules.form.custom")}</option>}
          </SelectInput>
        )}
      </Field>
      {showCustom && (
        <TextInput
          aria-label={label}
          defaultValue={value}
          placeholder="model:groq/openai/gpt-oss-20b"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
    </div>
  );
}

/** Target + ordered fallbacks. Reordering uses buttons (no drag and drop), so it works from the keyboard. */
export function ChainEditor({
  idPrefix,
  target,
  fallbacks,
  vocab,
  problems,
  onChange,
  localOnly,
}: {
  idPrefix: string;
  target: string;
  fallbacks: string[];
  vocab: RulesVocab;
  /** Problems by field path suffix: "target", "fallbacks[0]", "fallbacks". */
  problems: Map<string, string>;
  onChange: (target: string, fallbacks: string[]) => void;
  localOnly?: boolean;
}) {
  const set = (next: string[]) => onChange(target, next);
  const move = (i: number, d: -1 | 1) => {
    const next = [...fallbacks];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };
  return (
    <div className="grid gap-3">
      <TargetPicker
        id={`${idPrefix}-target`}
        label={tRules("rules.form.target")}
        help={tRules("rules.form.targetHelp")}
        value={target}
        vocab={vocab}
        problem={problems.get("target")}
        onChange={(v) => onChange(v, fallbacks)}
        localOnly={localOnly}
      />
      {!localOnly && (
        <fieldset className="grid gap-2">
          <legend className="pb-1 text-sm font-semibold">{tRules("rules.form.fallbacks")}</legend>
          {problems.get("fallbacks") && <p className="text-[0.8125rem] font-semibold text-err">{problems.get("fallbacks")}</p>}
          <ol className="grid gap-2">
            {fallbacks.map((f, i) => (
              <li key={`${i}-${f}`} className="flex items-start gap-1.5">
                <span aria-hidden className="grid h-(--ctl) w-6 shrink-0 place-items-center text-sm tabular-nums text-ink-muted">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <TargetPicker
                    id={`${idPrefix}-fb-${i}`}
                    label={`${tRules("rules.form.fallbacks")} ${i + 1}`}
                    value={f}
                    vocab={vocab}
                    problem={problems.get(`fallbacks[${i}]`)}
                    onChange={(v) => set(fallbacks.map((x, j) => (j === i ? v : x)))}
                  />
                </div>
                <span className="flex shrink-0 gap-0.5 pt-[1.65rem]">
                  <Button type="button" size="icon" variant="ghost" disabled={i === 0} aria-label={tRules("rules.form.moveUp", { n: i + 1 })} onClick={() => move(i, -1)} className="size-9 min-h-9">
                    <ArrowUp aria-hidden className="size-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" disabled={i === fallbacks.length - 1} aria-label={tRules("rules.form.moveDown", { n: i + 1 })} onClick={() => move(i, 1)} className="size-9 min-h-9">
                    <ArrowDown aria-hidden className="size-4" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" aria-label={tRules("rules.form.removeFallback", { n: i + 1 })} onClick={() => set(fallbacks.filter((_, j) => j !== i))} className="size-9 min-h-9">
                    <X aria-hidden className="size-4" />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="glass"
            disabled={fallbacks.length >= vocab.limits.max_fallbacks}
            onClick={() => set([...fallbacks, "model:fast"])}
            className="justify-self-start"
          >
            <Plus aria-hidden className="size-4" /> {tRules("rules.form.addFallback")}
          </Button>
        </fieldset>
      )}
    </div>
  );
}
