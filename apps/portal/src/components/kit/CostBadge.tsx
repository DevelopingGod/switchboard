import { BadgeCheck, Calculator, CircleDollarSign, CircleHelp } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";
import { Skeleton, LoadingLabel } from "./Skeleton";

export interface CostBadgeProps {
  kind: "free" | "paid" | "estimate" | "unknown";
  /** Preformatted, e.g. "$0.04". */
  amount?: string;
  state?: "default" | "loading" | "error" | "disabled";
  className?: string;
}

/** Cost is always stated in words and an icon, ahead of the action it describes. */
export function CostBadge({ kind, amount = "", state = "default", className }: CostBadgeProps) {
  if (state === "loading") {
    return (
      <span aria-busy className={cn("inline-flex", className)}>
        <Skeleton className="h-7 w-20 rounded-chip" />
        <LoadingLabel />
      </span>
    );
  }
  const effective = state === "error" ? "unknown" : kind;
  const Icon = { free: BadgeCheck, paid: CircleDollarSign, estimate: Calculator, unknown: CircleHelp }[effective];
  const text =
    effective === "free"
      ? t("cost.free")
      : effective === "paid"
        ? t("cost.paid", { amount })
        : effective === "estimate"
          ? t("cost.estimate", { amount })
          : t("cost.unknown");
  return (
    <span
      aria-disabled={state === "disabled" || undefined}
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-chip border border-hairline bg-glass-strong px-2.5 text-[0.8125rem] font-semibold tabular-nums",
        effective === "free" && "text-ok",
        effective === "paid" && "text-ink",
        effective === "estimate" && "text-accent-strong",
        effective === "unknown" && "text-ink-muted",
        state === "disabled" && "opacity-55",
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
      {text}
    </span>
  );
}
