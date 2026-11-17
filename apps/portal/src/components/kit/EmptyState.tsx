import * as React from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";
import { Skeleton, LoadingLabel } from "./Skeleton";

export interface EmptyStateProps {
  title?: string;
  /** Empty states teach: say what the thing is, then offer a first step. */
  body?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  state?: "default" | "loading" | "error" | "disabled";
  /** Heading level; use "h3" when nested under a section heading. */
  headingAs?: "h2" | "h3";
  className?: string;
}

export function EmptyState({ title, body, icon, action, state = "default", headingAs: Heading = "h2", className }: EmptyStateProps) {
  if (state === "loading") {
    return (
      <div aria-busy className={cn("grid justify-items-center gap-3 p-8", className)}>
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
        <LoadingLabel />
      </div>
    );
  }
  const isErr = state === "error";
  return (
    <div
      role={isErr ? "alert" : undefined}
      aria-disabled={state === "disabled" || undefined}
      className={cn("grid justify-items-center gap-3 p-8 text-center", state === "disabled" && "opacity-55", className)}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-12 place-items-center rounded-full bg-accent-soft",
          isErr ? "text-err" : "text-accent-strong",
        )}
      >
        {isErr ? <AlertTriangle className="size-6" /> : (icon ?? <Inbox className="size-6" />)}
      </span>
      <Heading className="heading text-xl!">{isErr ? t("state.error") : (title ?? t("state.empty"))}</Heading>
      {body && <p className="max-w-md leading-relaxed text-ink-muted">{body}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
