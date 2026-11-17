"use client";

import dynamic from "next/dynamic";
import { useHydrated } from "@/lib/use-hydrated";
import { CircleHelp } from "lucide-react";
import { explainTriggerClass, type ExplainPopoverProps } from "./explain-shared";
import { t } from "@/i18n/strings";

export type { ExplainPopoverProps };

// Radix Popover is ~23 KB gzip: it loads right after hydration so it stays out of the initial JS.
// Until then a static, identically styled trigger holds the layout.
const Impl = dynamic(() => import("./ExplainPopoverImpl"), { ssr: false });

/** The `?` next to every setting: 2–3 lines plus a "learn more" link. */
export function ExplainPopover(props: ExplainPopoverProps) {
  const hydrated = useHydrated();
  if (hydrated) return <Impl {...props} />;
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={t("explain.open", { topic: props.topic })}
      className={explainTriggerClass(props.className)}
    >
      <CircleHelp aria-hidden className="size-4" />
    </button>
  );
}
