import * as React from "react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

/** Original mark: a dial ring with an open gap, a dot handle and a centre knob. */
export function LogoMark({ className }: { className?: string }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 40 40" aria-hidden className={cn("size-9", className)}>
      <defs>
        <linearGradient id={id} x1="6" y1="34" x2="36" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6d72de" />
          <stop offset="1" stopColor="#b3b6fa" />
        </linearGradient>
      </defs>
      <path d="M9.39 30.61A15 15 0 1 1 35 20" fill="none" stroke={`url(#${id})`} strokeWidth="5" strokeLinecap="round" />
      <circle cx="35" cy="20" r="4.4" fill="#8b8fe8" stroke="var(--glass-strong)" strokeWidth="2" />
      <circle cx="20" cy="20" r="4" fill="currentColor" />
      <path d="M20 20 12.5 27.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, showWordmark = true }: { className?: string; showWordmark?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-ink", className)}>
      <LogoMark />
      {showWordmark && (
        <span className="font-display text-[1.375rem] font-extrabold tracking-[-0.045em]">{t("app.name")}</span>
      )}
    </span>
  );
}
