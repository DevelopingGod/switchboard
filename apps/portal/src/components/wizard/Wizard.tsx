"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ColumnsArt } from "@/components/kit/ColumnsArt";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { Button } from "@/components/ui/button";
import { saveOnboarding } from "@/app/welcome/actions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import type { CatalogModel, ConnectionRow, OnboardingResponse, OnboardingState, Preset, LocalProfileView } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { type WizardKey, tWizard } from "@/i18n/wizard";
import { STEPS, neededProviders } from "@/lib/wizard";
import { ConnectStep, FinishStep, GoalsStep, PresetStep, StepList, WelcomeStep } from "./steps";

interface Props {
  initial: OnboardingState | null;
  goalMap: OnboardingResponse["goals"];
  rows: ConnectionRow[];
  modelsByProvider: Record<string, CatalogModel[]>;
  startStep: number;
  localProfile?: LocalProfileView | null;
  /** "Run setup again" from Settings: prefilled, nothing is saved until Finish; Cancel returns. */
  again?: boolean;
}

/** First-run wizard (SPEC §8b). Progress is saved in the router on every step, so it resumes anywhere. */
export function Wizard({ initial, goalMap, rows, modelsByProvider, startStep, again = false, localProfile = null }: Props) {
  const router = useRouter();
  const prefs = usePrefs();
  const nameId = React.useId();
  const heading = React.useRef<HTMLHeadingElement>(null);
  const [step, setStep] = React.useState(startStep);
  const [name, setName] = React.useState(initial?.name || prefs.name || "");
  const [goals, setGoals] = React.useState<string[]>(initial?.goals ?? []);
  const [preset, setPreset] = React.useState<Preset>(initial?.preset ?? "balanced");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const id = STEPS[step];
  const needed = neededProviders(goals, goalMap);
  const connected = needed
    .map((n) => rows.find((r) => r.provider === n.provider))
    .filter((r): r is ConnectionRow => !!r && ["connected", "logged_in"].includes(r.status))
    .map((r) => r.name);
  const blocked = id === "goals" && goals.length === 0;

  // Move focus to the step heading so screen readers and keyboard users land on the new step.
  const shown = React.useRef(step);
  React.useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);

  const persist = async (to: number, extra: { skipped?: boolean; completed?: boolean } = {}) => {
    if (again && !extra.completed) return true; // staged: written only on Finish
    setBusy(true);
    setError(null);
    const r = await saveOnboarding({ step: STEPS[to], name, goals, preset, ...extra });
    setBusy(false);
    if (!r.ok) setError(`${tWizard("wizard.saveFailed")}: ${r.error}`);
    else if (name.trim()) setPrefs({ name: name.trim() });
    return r.ok;
  };

  const go = async (to: number) => {
    if (to < 0 || to >= STEPS.length) return;
    if (await persist(to)) setStep(to);
  };

  const toggle = (g: string) => setGoals((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));

  return (
    <div className="mx-auto grid max-w-[78rem] items-start gap-8 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
      <GlassPanel as="aside" blur={2} className="grid content-start gap-6 lg:sticky lg:top-24">
        <ColumnsArt className="text-ink" />
        <h1 className="heading">{tWizard("wizard.title")}</h1>
        <StepList steps={STEPS} current={step} />
      </GlassPanel>

      <GlassPanel as="section" tone="strong" aria-labelledby="wizard-step" className="grid gap-6 p-5! sm:p-7!">
        <header className="grid gap-1">
          <p className="label">{tWizard("wizard.step", { n: step + 1, total: STEPS.length })}</p>
          <h2 id="wizard-step" ref={heading} tabIndex={-1} className="heading focus:outline-none">
            {id === "finish" ? tWizard("wizard.finish.title", { name: name.trim() || t("home.fallbackName") }) : tWizard(`wizard.${id}.title` as WizardKey)}
          </h2>
        </header>

        {id === "welcome" && <WelcomeStep name={name} onName={setName} nameId={nameId} />}
        {id === "goals" && <GoalsStep available={Object.keys(goalMap)} goals={goals} onToggle={toggle} />}
        {id === "connect" && <ConnectStep needed={needed} rows={rows} modelsByProvider={modelsByProvider} localProfile={localProfile} />}
        {id === "preset" && <PresetStep preset={preset} onPick={setPreset} />}
        {id === "finish" && <FinishStep goals={goals} preset={preset} connected={connected} />}

        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}

        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline pt-5">
          <Button variant="ghost" disabled={step === 0 || busy} onClick={() => go(step - 1)}>
            {tWizard("wizard.back")}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (again) router.push("/settings");
              else if (await persist(step, { skipped: true })) router.push("/");
            }}
          >
            {again ? tWizard("wizard.cancelAgain") : tWizard("wizard.skip")}
          </Button>
          {id === "finish" ? (
            <Button
              className="ml-auto"
              loading={busy}
              onClick={async () => {
                if (await persist(step, { completed: true })) {
                  router.push(again ? "/settings" : "/");
                  router.refresh();
                }
              }}
            >
              {again ? tWizard("wizard.saveAgain") : tWizard("wizard.open")}
            </Button>
          ) : (
            <Button className="ml-auto" loading={busy} disabled={blocked} aria-describedby={blocked ? "goals-empty" : undefined} onClick={() => go(step + 1)}>
              {tWizard("wizard.next")}
            </Button>
          )}
        </footer>
      </GlassPanel>
    </div>
  );
}
