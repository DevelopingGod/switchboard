"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3 text-sm text-ink placeholder:text-ink-muted aria-[invalid=true]:border-err";

/** Label + control + problem for one field. The problem is announced with the control (aria-describedby). */
export function Field({
  label,
  id,
  help,
  problem,
  className,
  children,
}: {
  label: string;
  id: string;
  help?: string;
  problem?: string;
  className?: string;
  children: (a: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => React.ReactNode;
}) {
  const desc = [help ? `${id}-help` : null, problem ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid content-start gap-1", className)}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {children({ id, ...(problem ? { "aria-invalid": true as const } : {}), "aria-describedby": desc })}
      {help && (
        <p id={`${id}-help`} className="text-[0.8125rem] text-ink-muted">
          {help}
        </p>
      )}
      {problem && (
        <p id={`${id}-err`} className="text-[0.8125rem] font-semibold text-err">
          {problem}
        </p>
      )}
    </div>
  );
}

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} type="text" {...p} className={cn(control, className)} />;
});

export const SelectInput = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function SelectInput({ className, ...p }, ref) {
  return <select ref={ref} {...p} className={cn(control, className)} />;
});

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...p }, ref) {
  return <textarea ref={ref} {...p} className={cn(control, "min-h-24 py-2 leading-relaxed", className)} />;
});

/** A number that may be empty (= "use the rule's own / the default"). Reports `undefined` when cleared. */
export function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  ...rest
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "step" | "type">) {
  const [text, setText] = React.useState(value === undefined ? "" : String(value));
  // Follow outside changes (reset, discard) without fighting the keystrokes in progress: the typed
  // text is shown while it still parses to `value`, otherwise `value` wins.
  const parsed = text.trim() === "" ? undefined : Number(text);
  const shown = parsed === value ? text : value === undefined ? "" : String(value);
  return (
    <input
      {...rest}
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      value={shown}
      className={cn(control, "tabular-nums")}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value.trim() === "" ? undefined : Number(e.target.value);
        onChange(n === undefined || Number.isNaN(n) ? undefined : n);
      }}
    />
  );
}

export function Check({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex min-h-(--ctl) items-center gap-2.5 text-sm font-semibold">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--accent-strong)]" />
      {children}
    </label>
  );
}
