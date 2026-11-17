import { AlertTriangle, Bot, Check, Square, X } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { StatusBadge, type Status } from "./StatusBadge";
import { RouteChip } from "./RouteChip";
import { CostBadge } from "./CostBadge";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

export interface JobCardProps {
  title: string;
  agent: string;
  status: Extract<Status, "queued" | "running" | "needsApproval" | "done" | "failed">;
  /** 0–100 while running. */
  progress?: number;
  elapsed?: string;
  cost?: { kind: "free" | "paid" | "estimate"; amount?: string };
  route?: { target: string; rule?: string };
  onApprove?: () => void;
  onReject?: () => void;
  onStop?: () => void;
  onRetry?: () => void;
  state?: "default" | "loading" | "empty" | "error" | "disabled";
  className?: string;
}

export function JobCard({
  title,
  agent,
  status,
  progress,
  elapsed,
  cost,
  route,
  onApprove,
  onReject,
  onStop,
  onRetry,
  state = "default",
  className,
}: JobCardProps) {
  const disabled = state === "disabled";

  if (state === "loading") {
    return (
      <GlassPanel as="article" aria-busy className={cn("grid gap-3", className)}>
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-2 w-full rounded-chip" />
        <LoadingLabel />
      </GlassPanel>
    );
  }
  if (state === "empty") {
    return (
      <GlassPanel as="article" className={className}>
        <EmptyState headingAs="h3" title={t("empty.jobsTitle")} body={t("empty.jobsBody")} icon={<Bot className="size-6" />} action={<Button size="sm">{t("empty.jobsAction")}</Button>} />
      </GlassPanel>
    );
  }

  const isErr = state === "error";
  const effective = isErr ? "failed" : status;
  return (
    <GlassPanel as="article" aria-disabled={disabled || undefined} className={cn("grid gap-3", disabled && "opacity-55", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-bold leading-snug tracking-tight">{title}</h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
            <Bot aria-hidden className="size-4" />
            <span className="label">{t("job.agent")}</span> {agent}
          </p>
        </div>
        <StatusBadge status={effective} />
      </header>

      {effective === "running" && progress !== undefined && (
        <div className="grid gap-1.5">
          <div
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-valuetext={t("job.progress", { pct: progress })}
            className="h-2 overflow-hidden rounded-chip bg-track"
          >
            <div className="h-full rounded-chip bg-accent-strong transition-[width] duration-(--d-slow) ease-(--ease-out)" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-sm tabular-nums text-ink-muted">
            {t("job.progress", { pct: progress })}
            {elapsed && ` · ${t("job.elapsed", { time: elapsed })}`}
          </p>
        </div>
      )}

      {isErr && (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-err">
          <AlertTriangle aria-hidden className="size-4" /> {t("state.error")}
        </p>
      )}
      {effective === "needsApproval" && <p className="text-sm font-semibold text-warn">{t("job.needsYou")}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {route && <RouteChip {...route} />}
        {cost && <CostBadge {...cost} />}
      </div>

      <footer className="flex flex-wrap gap-2">
        {effective === "needsApproval" && (
          <>
            <Button size="sm" onClick={onApprove} disabled={disabled}>
              <Check aria-hidden className="size-4" /> {t("job.approve")}
            </Button>
            <Button size="sm" variant="danger" onClick={onReject} disabled={disabled}>
              <X aria-hidden className="size-4" /> {t("job.reject")}
            </Button>
          </>
        )}
        {effective === "running" && (
          <Button size="sm" variant="glass" onClick={onStop} disabled={disabled}>
            <Square aria-hidden className="size-3.5" /> {t("job.stop")}
          </Button>
        )}
        {isErr && onRetry && (
          <Button size="sm" variant="glass" onClick={onRetry}>
            {t("state.retry")}
          </Button>
        )}
      </footer>
    </GlassPanel>
  );
}
