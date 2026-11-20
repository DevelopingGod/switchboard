import { GlassPanel } from "@/components/kit/GlassPanel";
import type { JobEventRow, JobView } from "@/lib/router-types";
import { type JobsKey, tJobs } from "@/i18n/jobs";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const s = (v: unknown) => (v == null ? "" : String(v));

/** One job_events row in plain words (the raw kinds stay in the router's log). */
export function eventText(e: JobEventRow, job: Pick<JobView, "agent_label">): string {
  const gate = e.gate ? tJobs(`gate.${s(e.gate)}` as JobsKey).toLowerCase().replace(/^approve the |^review the /, "") : "";
  switch (e.kind) {
    case "created":
      return tJobs("timeline.created", { agents: (e.agent_chain as string[] | undefined)?.join(", ") ?? job.agent_label, autonomy: s(e.autonomy) });
    case "worktree":
      return tJobs("timeline.worktree", { branch: s(e.branch) });
    case "fallback":
      return tJobs("timeline.fallback", { skipped: ((e.skipped as { agent: string; reason: string }[]) ?? []).map((x) => `${x.agent} (${x.reason})`).join("; ") });
    case "run_started":
      return tJobs("timeline.run_started", { agent: s(e.agent) || job.agent_label, kind: tJobs(`timeline.kind.${s(e.run_kind) || "edit"}` as JobsKey) });
    case "run_finished":
      return tJobs("timeline.run_finished", { status: s(e.status), turns: e.turns ? `, ${s(e.turns)} turns` : "" });
    case "needs_approval":
      return tJobs("timeline.needs_approval", { gate });
    case "approved":
    case "rejected": {
      const key = (e.note ? `timeline.${e.kind}Note` : `timeline.${e.kind}`) as JobsKey;
      return tJobs(key, { gate, note: s(e.note) }) + (e.by === "paperclip" ? tJobs("timeline.paperclip") : "");
    }
    case "committed":
      return tJobs("timeline.committed", { sha: s(e.sha).slice(0, 10), branch: s(e.branch) });
    case "commit_failed":
      return tJobs("timeline.commit_failed", { error: s(e.error) });
    case "stop_requested":
    case "done":
      return tJobs(`timeline.${e.kind}` as JobsKey);
    case "worktree_removed":
    case "branch_merged":
      return tJobs(`timeline.${e.kind}` as JobsKey, { branch: s(e.branch) });
    case "approval_expired":
      return tJobs("timeline.approval_expired", { hours: s(e.hours) });
    case "failed":
    case "stopped":
      return tJobs(`timeline.${e.kind}` as JobsKey, { error: s(e.error) });
    default:
      return tJobs("timeline.other", { kind: e.kind });
  }
}

export function JobTimeline({ job }: { job: JobView }) {
  const events = job.events ?? [];
  return (
    <GlassPanel tone="strong">
      <ol aria-label={tJobs("timeline.label")} className="grid gap-3">
        {events.map((e) => (
          <li key={e.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
            <time dateTime={e.at} className="font-mono text-[0.8125rem] text-ink-muted tabular-nums" suppressHydrationWarning>
              {timeFmt.format(new Date(e.at))}
            </time>
            <span className="min-w-0 break-words">{eventText(e, job)}</span>
          </li>
        ))}
      </ol>
    </GlassPanel>
  );
}
