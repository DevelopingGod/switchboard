import { Network, Package, Workflow } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import type { FlowStep, JobPacks } from "@/lib/packs-types";
import { tPacks } from "@/i18n/packs";

/** The job page's Packs panel (M4.5a): its workflow step, what each pack set up (git-ignored), and the graph. */
export function JobPacksPanel({ packs, step }: { packs: JobPacks | null; step: FlowStep | null }) {
  const g = packs?.graphify;
  const entries = Object.entries(packs?.packs ?? {});
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby="job-packs-h" className="grid gap-2.5 text-sm">
      <h2 id="job-packs-h" className="label">
        {tPacks("job.panel")}
      </h2>
      {step && (
        <p className="flex items-start gap-1.5">
          <Workflow aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <span>
            <span className="font-semibold">{step.label}</span>
            <br />
            {tPacks("job.step", { n: step.index + 1, count: step.count, step: step.step })}
          </span>
        </p>
      )}
      {packs?.state === "setting_up" && <p className="text-ink-muted">{tPacks("job.settingUp")}</p>}
      {entries.map(([id, p]) => (
        <div key={id} className="grid gap-0.5">
          <p className="flex items-center gap-1.5 font-semibold">
            <Package aria-hidden className="size-4 shrink-0 text-ink-muted" />
            {tPacks("job.setUp", { name: p.name, version: p.version })}
          </p>
          <p className="text-ink-muted">{tPacks("job.owned", { n: p.owned.length })}</p>
          {p.edits.length > 0 && <p className="text-ink-muted">{tPacks("job.edits", { n: p.edits.length })}</p>}
        </div>
      ))}
      {(packs?.refused ?? []).map((r) => (
        <p key={r.id} className="text-ink-muted">
          {tPacks("job.refused", { reason: r.reason })}
        </p>
      ))}
      {g && (g.used || g.control || g.reason) && (
        <p className="flex items-start gap-1.5">
          <Network aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <span>
            {g.used
              ? tPacks("job.graphUsed", { nodes: g.nodes ?? "?" })
              : g.control
                ? tPacks("job.graphControl")
                : tPacks("job.graphNot", { reason: g.reason ?? "" })}
          </span>
        </p>
      )}
    </GlassPanel>
  );
}
