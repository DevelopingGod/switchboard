import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

export interface StatCardProps {
  label: string;
  value?: string;
  hint?: string;
  /** Optional visual (usually a <Dial/>) shown beside the number. */
  visual?: React.ReactNode;
  state?: "default" | "loading" | "empty" | "error" | "disabled";
  onRetry?: () => void;
  className?: string;
}

/** One headline number, three at most per card (SPEC §8c). */
export function StatCard({ label, value, hint, visual, state = "default", onRetry, className }: StatCardProps) {
  return (
    <GlassPanel
      as="article"
      aria-busy={state === "loading" || undefined}
      aria-disabled={state === "disabled" || undefined}
      className={cn("flex min-h-36 items-center justify-between gap-4", state === "disabled" && "opacity-55", className)}
    >
      <div className="grid gap-2">
        <p className="label">{label}</p>
        {state === "loading" ? (
          <>
            <Skeleton className="h-10 w-28" />
            <Skeleton className="h-4 w-36" />
            <LoadingLabel />
          </>
        ) : state === "error" ? (
          <div role="alert" className="grid gap-2">
            <p className="flex items-center gap-1.5 font-semibold text-err">
              <AlertTriangle aria-hidden className="size-4" /> {t("state.error")}
            </p>
            {onRetry && (
              <Button size="sm" variant="glass" onClick={onRetry}>
                {t("state.retry")}
              </Button>
            )}
          </div>
        ) : state === "empty" ? (
          <>
            <p className="stat-value text-ink-muted">—</p>
            <p className="text-sm text-ink-muted">{t("stat.noData")}</p>
          </>
        ) : (
          <>
            <p className="stat-value">{value}</p>
            {hint && <p className="text-sm text-ink-muted">{hint}</p>}
          </>
        )}
      </div>
      {state === "default" || state === "disabled" ? visual : null}
    </GlassPanel>
  );
}
