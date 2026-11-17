"use client";

import * as React from "react";
import Link from "next/link";
import * as m from "motion/react-m";
import { GlassPanel } from "./GlassPanel";
import { cn } from "@/lib/cn";
import { shared } from "@/design/design-tokens";

export interface PillTab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** When every tab has an href the component renders as navigation links. */
  href?: string;
  disabled?: boolean;
}

export interface PillTabsProps {
  items: readonly PillTab[];
  value: string | null;
  onChange?: (id: string) => void;
  label: string;
  className?: string;
}

/** White pill tabs. Active = raised white pill with bold label (and aria-current / aria-selected). */
export function PillTabs({ items, value, onChange, label, className }: PillTabsProps) {
  const group = React.useId();
  const asNav = items.every((i) => i.href);

  const body = items.map((item) => {
    const active = item.id === value;
    const inner = (
      <>
        {active && (
          <m.span
            layoutId={`pill-${group}`}
            transition={{ type: "spring", ...shared.spring }}
            className="absolute inset-0 rounded-chip bg-pill-active shadow-[0_4px_14px_-4px_rgba(60,60,160,0.4)] ring-1 ring-accent-strong/30"
          />
        )}
        <span className="relative z-10 inline-flex items-center gap-2">
          {item.icon}
          {item.label}
        </span>
      </>
    );
    const cls = cn(
      "relative inline-flex min-h-9 items-center rounded-chip px-4 text-sm tracking-tight transition-colors duration-(--d-fast)",
      active ? "font-bold text-ink" : "font-medium text-ink-muted hover:text-ink",
      item.disabled && "pointer-events-none opacity-55",
    );
    return asNav ? (
      <li key={item.id}>
        <Link href={item.href!} aria-current={active ? "page" : undefined} aria-disabled={item.disabled || undefined} className={cls}>
          {inner}
        </Link>
      </li>
    ) : (
      <button
        key={item.id}
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        disabled={item.disabled}
        onClick={() => onChange?.(item.id)}
        className={cls}
      >
        {inner}
      </button>
    );
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (asNav) return;
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.id === value);
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = enabled[(idx + d + enabled.length) % enabled.length];
    onChange?.(next.id);
    requestAnimationFrame(() => document.getElementById(`${group}-${next.id}`)?.focus());
  };

  return asNav ? (
    <GlassPanel as="nav" aria-label={label} padded={false} className={cn("rounded-chip p-1", className)}>
      <ul className="flex items-center gap-0.5">{body}</ul>
    </GlassPanel>
  ) : (
    <GlassPanel
      padded={false}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center gap-0.5 rounded-chip p-1", className)}
    >
      {items.map((item, i) => React.cloneElement(body[i] as React.ReactElement<{ id?: string }>, { id: `${group}-${item.id}` }))}
    </GlassPanel>
  );
}
