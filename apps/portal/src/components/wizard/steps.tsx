"use client";

import * as React from "react";
import { Check, Lock } from "lucide-react";
import { ModeSwitch } from "@/components/shell/ModeSwitch";
import { ProviderCardFor } from "@/components/connections/ProviderCards";
import { CostBadge } from "@/components/kit/CostBadge";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { cn } from "@/lib/cn";
import { GOAL_ORDER, neededProviders } from "@/lib/wizard";
import type { CatalogModel, ConnectionRow, Preset, LocalProfileView } from "@/lib/router-types";
import { type WizardKey, tWizard } from "@/i18n/wizard";

export const PRESETS: Preset[] = ["free", "balanced", "best"];

export const goalLabel = (id: string) => (GOAL_ORDER.includes(id as never) ? tWizard(`wizard.goals.items.${id}.label` as WizardKey) : id);

const field =
  "min-h-(--ctl) w-full rounded-control border border-hairline bg-glass-strong px-3 text-ink placeholder:text-ink-muted";

export function WelcomeStep({ name, onName, nameId }: { name: string; onName: (v: string) => void; nameId: string }) {
  return (
    <div className="grid gap-5">
      <p className="max-w-xl text-lg leading-relaxed text-ink-muted">{tWizard("wizard.welcome.body")}</p>
      <div className="grid max-w-sm gap-1.5">
        <label htmlFor={nameId} className="label">
          {tWizard("wizard.welcome.nameLabel")}
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(e) => onName(e.target.value)}
          maxLength={60}
          autoComplete="given-name"
          placeholder={tWizard("wizard.welcome.namePlaceholder")}
          className={field}
        />
      </div>
      <div className="grid gap-1.5">
        <p className="label">{tWizard("wizard.welcome.modeLabel")}</p>
        <div>
          <ModeSwitch />
        </div>
      </div>
    </div>
  );
}

export function GoalsStep({
  available,
  goals,
  onToggle,
}: {
  available: string[];
  goals: string[];
  onToggle: (id: string) => void;
}) {
  const ids = GOAL_ORDER.filter((g) => available.includes(g));
  return (
    <fieldset className="grid gap-3">
      <legend className="max-w-xl pb-1 text-ink-muted">{tWizard("wizard.goals.body")}</legend>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
        {ids.map((id) => (
          <label
            key={id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-control border border-hairline bg-glass-strong p-3.5",
              "has-checked:border-accent-strong has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-strong",
            )}
          >
            <input
              type="checkbox"
              checked={goals.includes(id)}
              onChange={() => onToggle(id)}
              className="mt-1 size-4 shrink-0 accent-(--accent-strong)"
            />
            <span className="grid gap-0.5">
              <span className="font-semibold tracking-tight">{tWizard(`wizard.goals.items.${id}.label` as WizardKey)}</span>
              <span className="text-sm text-ink-muted">{tWizard(`wizard.goals.items.${id}.hint` as WizardKey)}</span>
            </span>
          </label>
        ))}
      </div>
      {goals.length === 0 && (
        <p id="goals-empty" className="text-sm text-ink-muted">
          {tWizard("wizard.goals.empty")}
        </p>
      )}
    </fieldset>
  );
}

export function ConnectStep({
  needed,
  rows,
  modelsByProvider,
  localProfile = null,
}: {
  needed: ReturnType<typeof neededProviders>;
  rows: ConnectionRow[];
  modelsByProvider: Record<string, CatalogModel[]>;
  localProfile?: LocalProfileView | null;
}) {
  if (needed.length === 0) return <p className="text-ink-muted">{tWizard("wizard.connect.none")}</p>;
  return (
    <div className="grid gap-4">
      <p className="max-w-xl text-ink-muted">{tWizard("wizard.connect.body")}</p>
      <div className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]">
        {needed.map((n) => {
          const row = rows.find((r) => r.provider === n.provider);
          if (!row) return null;
          return (
            <div key={n.provider} className="grid content-start gap-1.5">
              <ProviderCardFor row={row} models={modelsByProvider[n.provider] ?? []} />
              <p className="px-2 text-xs text-ink-muted">{tWizard("wizard.connect.forGoals", { goals: n.for.map(goalLabel).join(", ") })}</p>
              {n.provider === "ollama" && localProfile && <LocalProfileLine v={localProfile} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PresetStep({ preset, onPick }: { preset: Preset; onPick: (p: Preset) => void }) {
  return (
    <fieldset className="grid gap-3">
      <legend className="max-w-xl pb-1 text-ink-muted">{tWizard("wizard.preset.body")}</legend>
      {PRESETS.map((id) => (
        <label
          key={id}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-control border border-hairline bg-glass-strong p-3.5",
            "has-checked:border-accent-strong has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-strong",
          )}
        >
          <input
            type="radio"
            name="preset"
            value={id}
            checked={preset === id}
            onChange={() => onPick(id)}
            className="mt-1 size-4 shrink-0 accent-(--accent-strong)"
          />
          <span className="grid gap-0.5">
            <span className="font-semibold tracking-tight">{tWizard(`wizard.preset.${id}.label` as WizardKey)}</span>
            <span className="text-sm text-ink-muted">{tWizard(`wizard.preset.${id}.body` as WizardKey)}</span>
          </span>
          {id === "free" && <CostBadge kind="free" className="ml-auto" />}
        </label>
      ))}
      <p className="text-sm text-ink-muted">{tWizard("wizard.preset.note")}</p>
    </fieldset>
  );
}

export function FinishStep({
  goals,
  preset,
  connected,
}: {
  goals: string[];
  preset: Preset;
  connected: string[];
}) {
  return (
    <div className="grid gap-5">
      <p className="max-w-xl text-ink-muted">{tWizard("wizard.finish.body")}</p>
      <dl className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]">
        {[
          [tWizard("wizard.finish.goals"), goals.length ? goals.map(goalLabel).join(", ") : tWizard("wizard.finish.none")],
          [tWizard("wizard.finish.preset"), tWizard(`wizard.preset.${preset}.label` as WizardKey)],
          [tWizard("wizard.finish.connected"), connected.length ? connected.join(", ") : tWizard("wizard.finish.none")],
        ].map(([k, v]) => (
          <div key={k} className="rounded-control border border-hairline bg-glass-strong p-3">
            <dt className="label">{k}</dt>
            <dd className="mt-1 font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <GlassPanel as="section" tone="solid" aria-labelledby="try-it" className="grid gap-1.5 font-sans!">
        <h3 id="try-it" className="flex items-center gap-2 font-semibold">
          <Lock aria-hidden className="size-4" />
          {tWizard("wizard.finish.tryTitle")}
          <span className="rounded-chip border border-hairline px-2 py-0.5 text-xs">{tWizard("wizard.finish.tryBadge")}</span>
        </h3>
        <p className="text-sm leading-relaxed opacity-90">{tWizard("wizard.finish.tryBody")}</p>
      </GlassPanel>
    </div>
  );
}

export function StepList({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol aria-label={tWizard("wizard.progress")} className="grid gap-2">
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className={cn("flex items-center gap-3 text-sm", i === current ? "font-semibold text-ink" : "text-ink-muted")}
        >
          <span
            aria-hidden
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold tabular-nums",
              i < current && "border-accent-strong bg-accent-strong text-on-accent",
              i === current && "border-accent-strong bg-accent-soft text-accent-strong",
              i > current && "border-hairline",
            )}
          >
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </span>
          {tWizard(`wizard.steps.${s}` as WizardKey)}
          {i < current && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

function LocalProfileLine({ v }: { v: LocalProfileView }) {
  const p = v.profiles.find((x) => x.name === v.active);
  if (!p) return null;
  const gpu = v.detected.vram_gb != null ? `${v.detected.vram_gb} GB GPU` : tWizard("wizard.connect.noGpu");
  const models = [p.classifier ? "Arch-Router" : null, p.general].filter(Boolean).join(" + ");
  return <p className="px-2 text-xs text-ink-muted">{tWizard("wizard.connect.localProfile", { gpu, label: p.label, models })}</p>;
}
