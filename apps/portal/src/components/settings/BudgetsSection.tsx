"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dial } from "@/components/kit/Dial";
import { useToast } from "@/components/kit/Toast";
import { saveSettings } from "@/app/settings/actions";
import type { SettingsView } from "@/lib/router-types";
import { tSet } from "@/i18n/settings";
import { Field, Section } from "./Section";

const money = (v: number) => `$${v.toFixed(2)}`;
const parse = (s: string) => {
  const n = Number(s.replace(/^\$/, "").trim());
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export default function BudgetsSection({ settings, spentToday }: { settings: SettingsView; spentToday: number | null }) {
  const { push } = useToast();
  const [perReq, setPerReq] = React.useState(String(settings.max_cost_usd));
  const [daily, setDaily] = React.useState(String(settings.daily_cap_usd));
  const [cur, setCur] = React.useState(settings);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();
  const used = spentToday == null || cur.daily_cap_usd <= 0 ? 0 : Math.min(100, (spentToday / cur.daily_cap_usd) * 100);

  const submit = async (patch: Parameters<typeof saveSettings>[0]) => {
    setBusy(true);
    setError(null);
    const r = await saveSettings(patch);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setCur(r.data);
    setPerReq(String(r.data.max_cost_usd));
    setDaily(String(r.data.daily_cap_usd));
    push({ tone: "success", title: tSet("saved") });
  };

  return (
    <Section id="budgets" title={tSet("section.budgets")} explain={tSet("budgets.explain")}>
      <p className="text-sm text-ink-muted">{tSet("budgets.lead")}</p>
      <div className="grid items-start gap-6 sm:grid-cols-[minmax(0,1fr)_auto]">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const a = parse(perReq);
            const b = parse(daily);
            if (a === null || b === null) return setError(tSet("budgets.invalid"));
            void submit({ max_cost_usd: a, daily_cap_usd: b });
          }}
        >
          <Field label={tSet("budgets.perRequest")} help={tSet("budgets.perRequestHelp", { value: money(cur.defaults.max_cost_usd) })} htmlFor={`${ids}-r`}>
            <input
              id={`${ids}-r`}
              inputMode="decimal"
              value={perReq}
              onChange={(e) => setPerReq(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="min-h-(--ctl) w-40 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
            />
          </Field>
          <Field label={tSet("budgets.daily")} help={tSet("budgets.dailyHelp", { value: money(cur.defaults.daily_cap_usd) })} htmlFor={`${ids}-d`}>
            <input
              id={`${ids}-d`}
              inputMode="decimal"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="min-h-(--ctl) w-40 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-err">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy}>
              {busy ? tSet("saving") : tSet("save")}
            </Button>
            {cur.overridden.some((k) => k !== "private_by_default") && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => submit({ max_cost_usd: null, daily_cap_usd: null })}>
                {tSet("reset")}
              </Button>
            )}
          </div>
        </form>
        {spentToday != null && (
          <div className="grid justify-items-center gap-1">
            <Dial value={used} label={tSet("budgets.today")} valueText={tSet("budgets.todayOf", { spent: money(spentToday), cap: money(cur.daily_cap_usd) })} size={132}>
              <span className="stat-value text-2xl">{Math.round(used)}%</span>
            </Dial>
            <p className="label">{tSet("budgets.today")}</p>
            <p className="text-sm tabular-nums text-ink-muted">{tSet("budgets.todayOf", { spent: money(spentToday), cap: money(cur.daily_cap_usd) })}</p>
          </div>
        )}
      </div>
    </Section>
  );
}
