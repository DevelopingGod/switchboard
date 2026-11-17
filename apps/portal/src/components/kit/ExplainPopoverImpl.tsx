"use client";

import { CircleHelp } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n/strings";

import { explainTriggerClass, type ExplainPopoverProps } from "./explain-shared";

/** The `?` next to every setting: 2–3 lines plus a "learn more" link. */
export default function ExplainPopoverImpl({ topic, title, children, learnMoreHref, disabled, className }: ExplainPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={t("explain.open", { topic })}
        className={explainTriggerClass(className)}
      >
        <CircleHelp aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent aria-label={title ?? topic}>
        {title && <p className="mb-1 font-semibold tracking-tight">{title}</p>}
        <div className="leading-relaxed text-ink-muted">{children}</div>
        {learnMoreHref && (
          <a href={learnMoreHref} className="mt-3 inline-block font-semibold text-accent-strong underline underline-offset-4">
            {t("explain.learnMore")}
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
