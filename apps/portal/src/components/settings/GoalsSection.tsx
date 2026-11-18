"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { saveOnboarding } from "@/app/welcome/actions";
import { GoalsStep, PresetStep } from "@/components/wizard/steps";
import type { Preset } from "@/lib/router-types";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

/** Same controls as the setup wizard's Goals and Preset steps; saved with one button. */
export default function GoalsSection({ available, goals: g0, preset: p0 }: { available: string[]; goals: string[]; preset: Preset }) {
  const { push } = useToast();
  const [goals, setGoals] = React.useState(g0);
  const [preset, setPreset] = React.useState<Preset>(p0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const toggle = (id: string) => setGoals((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  return (
    <Section id="goals" title={tSet("section.goals")} explain={tSet("goals.explain")}>
      <GoalsStep available={available} goals={goals} onToggle={toggle} />
      <h3 className="pt-2 text-sm font-semibold">{tSet("goals.presetTitle")}</h3>
      <PresetStep preset={preset} onPick={setPreset} />
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
      <div>
        <Button
          size="sm"
          loading={busy}
          disabled={goals.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await saveOnboarding({ goals, preset });
            setBusy(false);
            if (!r.ok) setError(r.error);
            else push({ tone: "success", title: tSet("saved") });
          }}
        >
          {busy ? tSet("saving") : tSet("save")}
        </Button>
      </div>
    </Section>
  );
}
