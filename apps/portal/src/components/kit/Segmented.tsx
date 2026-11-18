"use client";

import { cn } from "@/lib/cn";

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}

/** Small radio-group pill (Simple/Pro, theme, density). Selected = filled pill + bold text. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, className }: SegmentedProps<T>) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    onChange(options[(i + d + options.length) % options.length].value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
      className={cn("inline-flex rounded-chip border border-hairline bg-glass p-0.5", disabled && "opacity-55", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-tip={o.hint}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-h-8 rounded-chip px-3.5 text-[0.8125rem] transition-[background-color,box-shadow] duration-(--d-fast)",
              on
                ? "bg-pill-active font-bold text-ink shadow-[0_2px_10px_-2px_rgba(60,60,160,0.35)] ring-1 ring-accent-strong/40"
                : "font-medium text-ink-muted hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
