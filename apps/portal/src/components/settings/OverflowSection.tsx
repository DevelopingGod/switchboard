"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { saveOverflow } from "@/app/settings/actions";
import { usd } from "@/lib/job-format";
import type { OverflowSettings } from "@/lib/router-types";
import { tSubs } from "@/i18n/subscriptions";
import { Field, Section } from "./Section";

const input = "min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3 tabular-nums";

/** Settings → Paid overflow (M6.5, ADR 0015): off by default; a monthly budget and a paid model to turn on. */
export default function OverflowSection({ data }: { data: OverflowSettings }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [enabled, setEnabled] = React.useState(data.enabled);
  const [budget, setBudget] = React.useState(data.monthly_usd != null ? String(data.monthly_usd) : "");
  const [model, setModel] = React.useState(data.model ?? data.models[0]?.model ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const chosen = data.models.find((m) => m.model === model);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const b = budget.trim() ? Number(budget.replace(/^\$/, "")) : null;
    if (enabled && !(b != null && Number.isFinite(b) && b > 0)) return setError(tSubs("overflow.needBudget"));
    setBusy(true);
    setError(null);
    const r = await saveOverflow({ enabled, monthly_usd: b, model: model || null });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    push({ tone: "success", title: tSubs("overflow.saved") });
    router.refresh();
  };

  return (
    <Section id="overflow" title={tSubs("overflow.title")}>
      <p className="text-sm text-ink-muted">{tSubs("overflow.intro")}</p>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-[var(--accent-strong)]" />
          {tSubs("overflow.enabled")}
        </label>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <Field label={tSubs("overflow.budget")} htmlFor={`${ids}-b`}>
            <input id={`${ids}-b`} className={input} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="10" />
          </Field>
          <Field label={tSubs("overflow.model")} htmlFor={`${ids}-m`} help={data.models.length ? undefined : tSubs("overflow.noModels")}>
            <select id={`${ids}-m`} className={input} value={model} disabled={!data.models.length} onChange={(e) => setModel(e.target.value)}>
              {data.models.map((m) => (
                <option key={m.model} value={m.model}>
                  {`${m.model} (${m.providers.join(", ")})`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {chosen && !chosen.paid && <p className="text-[0.8125rem] text-ink-muted">{tSubs("overflow.testMode")}</p>}
        <p className="text-sm tabular-nums">{tSubs("overflow.spent", { spent: usd(data.spent_usd), left: data.left_usd != null ? usd(data.left_usd) : "—" })}</p>
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" loading={busy}>
            {tSubs("overflow.save")}
          </Button>
        </div>
      </form>
    </Section>
  );
}
