"use client";

import { ProviderCardFor } from "@/components/connections/ProviderCards";
import type { CatalogModel, ConnectionRow, LocalProfileView } from "@/lib/router-types";
import { tWizard } from "@/i18n/wizard";
import type { neededProviders } from "@/lib/wizard";
import { goalLabel } from "./steps";

/** Wizard step 3. Its own module because it pulls in the whole provider-card stack (key form, install
 * flow, recommended models, ~11 KB gzip); Wizard loads it lazily so /welcome stays far under budget. */
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
  // The intro text and the "nothing needed" message are rendered by Wizard with the page (LCP).
  return (
    <div className="grid gap-4">
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


function LocalProfileLine({ v }: { v: LocalProfileView }) {
  const p = v.profiles.find((x) => x.name === v.active);
  if (!p) return null;
  const gpu = v.detected.vram_gb != null ? `${v.detected.vram_gb} GB GPU` : tWizard("wizard.connect.noGpu");
  const models = [p.classifier ? "Arch-Router" : null, p.general].filter(Boolean).join(" + ");
  return <p className="px-2 text-xs text-ink-muted">{tWizard("wizard.connect.localProfile", { gpu, label: p.label, models })}</p>;
}

export default ConnectStep;
