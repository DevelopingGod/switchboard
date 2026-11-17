"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { testModel, type ModelTestResult } from "@/app/connections/actions";
import { formatContext, recommend } from "@/lib/recommend";
import type { CatalogModel } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tConn } from "@/i18n/connections";
import { BadgeChip } from "./shared";

type Outcome = { state: "testing" } | { state: "done"; result: ModelTestResult } | { state: "error"; error: string };

/** Up to three tagged models with their badges and a per-model Test (a direct call with the stored key). */
export function RecommendedModels({ provider, models }: { provider: string; models: CatalogModel[] }) {
  const { picks, untagged } = React.useMemo(() => recommend(models), [models]);
  const [outcomes, setOutcomes] = React.useState<Record<string, Outcome>>({});

  const run = async (id: string) => {
    setOutcomes((o) => ({ ...o, [id]: { state: "testing" } }));
    const r = await testModel(provider, id);
    setOutcomes((o) => ({ ...o, [id]: r.ok ? { state: "done", result: r.data } : { state: "error", error: r.error } }));
  };

  if (picks.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        {models.length ? tConn("card.untagged", { count: untagged || models.length }) : tConn("card.noModels")}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <h4 className="label">{tConn("card.recommended")}</h4>
      <ul className="grid gap-2">
        {picks.map(({ model, badges }) => {
          const o = outcomes[model.model_id];
          const name = model.display_name ?? model.model_id;
          const ctx = formatContext(model.context);
          return (
            <li key={model.model_id} className="grid gap-1.5 rounded-control border border-hairline bg-glass-strong p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" data-tip={name !== model.model_id ? model.model_id : undefined} data-tip-truncated>
                    {name}
                  </p>
                  {ctx && <p className="text-xs text-ink-muted">{tConn("card.ctx", { size: ctx })}</p>}
                </div>
                <Button
                  size="sm"
                  variant="glass"
                  loading={o?.state === "testing"}
                  onClick={() => run(model.model_id)}
                  aria-label={tConn("card.testModelLabel", { model: name })}
                >
                  {o?.state === "testing" ? tConn("card.testingModel") : tConn("card.testModel")}
                </Button>
              </div>
              <ul aria-label={tConn("card.recommended")} className="flex flex-wrap gap-1.5">
                {badges.map((b) => (
                  <li key={b}>
                    <BadgeChip badge={b} />
                  </li>
                ))}
              </ul>
              <p role="status" className="text-xs empty:hidden">
                {o?.state === "done" &&
                  (o.result.ok ? (
                    <span className="text-ok">{tConn("card.modelOk", { ms: o.result.latency_ms ?? 0 })}</span>
                  ) : (
                    <span className="text-err">{tConn("card.modelFail", { error: o.result.error ?? t("state.error") })}</span>
                  ))}
                {o?.state === "error" && <span className="text-err">{tConn("card.modelFail", { error: o.error })}</span>}
              </p>
            </li>
          );
        })}
      </ul>
      {untagged > 0 && <p className="text-xs text-ink-muted">{tConn("card.untagged", { count: untagged })}</p>}
    </div>
  );
}
