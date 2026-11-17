import type * as React from "react";
import { cn } from "@/lib/cn";

export interface ExplainPopoverProps {
  /** What is being explained; used for the accessible name. */
  topic: string;
  title?: string;
  /** Two or three lines. */
  children: React.ReactNode;
  learnMoreHref?: string;
  disabled?: boolean;
  className?: string;
}

export const explainTriggerClass = (className?: string) =>
  cn(
    "inline-grid size-7 place-items-center rounded-full text-ink-muted transition-colors",
    "hover:bg-accent-soft hover:text-ink disabled:opacity-55 disabled:pointer-events-none",
    className,
  );
