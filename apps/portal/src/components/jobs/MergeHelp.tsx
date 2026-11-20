import { GlassPanel } from "@/components/kit/GlassPanel";
import { CopyButton } from "@/components/kit/CopyButton";
import { mergeCommands } from "@/lib/job-format";
import type { JobView } from "@/lib/router-types";
import { tJobs } from "@/i18n/jobs";

/** Plain instructions for using the job's branch yourself. Switchboard never pushes or merges. */
export function MergeHelp({ job }: { job: JobView }) {
  if (!job.branch) return null;
  const cmd = mergeCommands(job.branch, job.project?.path);
  const committed = job.status === "done" && (job.events ?? []).some((e) => e.kind === "committed");
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby="merge-h" className="grid gap-3 text-sm">
      <h2 id="merge-h" className="font-display text-base font-bold tracking-tight">
        {tJobs("merge.title")}
      </h2>
      <p className="text-ink-muted">{tJobs("merge.lead")}</p>
      {!committed && <p className="text-ink-muted">{tJobs("merge.notYet", { branch: job.branch })}</p>}
      {(["log", "diff", "merge"] as const).map((k) => (
        <div key={k} className="grid gap-1">
          <p className="font-semibold">{tJobs(`merge.${k}`)}</p>
          <code className="solid-panel block p-2 font-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{cmd[k]}</code>
          <CopyButton text={cmd[k]} className="w-fit" />
        </div>
      ))}
    </GlassPanel>
  );
}
