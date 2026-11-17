"use client";

import dynamic from "next/dynamic";
import { ChevronDown, Lock, Sparkles } from "lucide-react";
import type { TargetsResponse } from "@/lib/router-types";
import { targetName } from "@/lib/chat-format";
import { FallbackSlot, LazyFallback } from "@/lib/lazy-fallback";
import { tChat } from "@/i18n/chat";

export interface TargetPickerProps {
  value: string;
  onChange: (target: string) => void;
  privateOn: boolean;
  disabled?: boolean;
  targets: TargetsResponse | null;
  onTargets: (t: TargetsResponse) => void;
}

export const triggerClass =
  "inline-flex min-h-9 items-center gap-1.5 rounded-chip border border-hairline bg-glass-strong px-3 text-[0.8125rem] font-semibold transition-colors hover:bg-pill-active disabled:opacity-60";

/** Trigger content shared by the static stand-in and the popover trigger. */
export function TriggerLabel({ value, privateOn, targets }: Pick<TargetPickerProps, "value" | "privateOn" | "targets">) {
  const name = targetName(value, targets);
  return (
    <>
      {privateOn ? <Lock aria-hidden className="size-3.5 text-accent-strong" /> : <Sparkles aria-hidden className="size-3.5 text-accent-strong" />}
      <span className="label">{tChat("chat.target.label")}</span>
      <span className="max-w-40 truncate">{name ?? tChat("chat.target.auto")}</span>
      <ChevronDown aria-hidden className="size-3.5 text-ink-muted" />
    </>
  );
}

const Impl = dynamic(() => import("./TargetPickerImpl"), { ssr: false, loading: FallbackSlot });

/** Composer target picker (SPEC §6.4 UI): Auto / aliases / models grouped by provider with badges. */
export function TargetPicker(props: TargetPickerProps) {
  const stand = (
    <button type="button" disabled={props.disabled} aria-haspopup="dialog" className={triggerClass}>
      <TriggerLabel value={props.value} privateOn={props.privateOn} targets={props.targets} />
    </button>
  );
  return (
    <LazyFallback value={stand}>
      <Impl {...props} />
    </LazyFallback>
  );
}
