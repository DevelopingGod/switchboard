import { AlertTriangle, ChevronRight, Route } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";
import { Skeleton, LoadingLabel } from "./Skeleton";

export interface RouteChipProps {
  target: string;
  rule?: string;
  /** Opens the decision log. */
  onClick?: () => void;
  state?: "default" | "loading" | "empty" | "error" | "disabled";
  className?: string;
}

/** "Routed to X by rule Y": every reply, job and media item carries one (SPEC §8b). */
export function RouteChip({ target, rule, onClick, state = "default", className }: RouteChipProps) {
  if (state === "loading") {
    return (
      <span aria-busy className={cn("inline-flex", className)}>
        <Skeleton className="h-8 w-56 rounded-chip" />
        <LoadingLabel />
      </span>
    );
  }
  const isErr = state === "error";
  const isEmpty = state === "empty";
  const Icon = isErr ? AlertTriangle : Route;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "disabled" || isErr || isEmpty}
      aria-label={isErr || isEmpty ? undefined : `${t("route.why")} ${t("route.routedTo", { target })}${rule ? ` ${t("route.byRule", { rule })}` : ""}`}
      className={cn(
        "group inline-flex min-h-8 max-w-full items-center gap-2 rounded-chip border border-hairline bg-glass-strong px-3 text-[0.8125rem] text-ink",
        "transition-[transform,background-color] duration-(--d-fast) ease-(--ease) enabled:hover:bg-pill-active enabled:active:scale-[0.98]",
        "disabled:opacity-60",
        isErr && "border-err text-err",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />
      {isErr ? (
        <span className="font-semibold">{t("route.unavailable")}</span>
      ) : isEmpty ? (
        <span className="font-semibold text-ink-muted">{t("route.pending")}</span>
      ) : (
        <span className="truncate">
          <span className="font-semibold">{t("route.routedTo", { target })}</span>
          {rule && <span className="text-ink-muted"> {t("route.byRule", { rule })}</span>}
        </span>
      )}
      {!isErr && !isEmpty && (
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" />
      )}
    </button>
  );
}
