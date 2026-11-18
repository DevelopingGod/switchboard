import * as React from "react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ExplainPopover } from "@/components/kit/ExplainPopover";

/** One settings section: heading, optional `?` explanation (SPEC §8b), content. */
export function Section({ id, title, explain, children }: { id: string; title: string; explain?: string; children: React.ReactNode }) {
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby={`s-${id}`} id={id} className="settings-section grid scroll-mt-28 gap-4">
      <header className="flex items-center gap-1.5">
        <h2 id={`s-${id}`} className="font-display text-xl font-bold tracking-tight">
          {title}
        </h2>
        {explain && (
          <ExplainPopover topic={title} title={title}>
            {explain}
          </ExplainPopover>
        )}
      </header>
      {children}
    </GlassPanel>
  );
}

/** Label + control + help on one row; stacks on phones. */
export function Field({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-semibold">
          {label}
        </label>
      ) : (
        <span className="text-sm font-semibold">{label}</span>
      )}
      {children}
      {help && <p className="text-[0.8125rem] text-ink-muted">{help}</p>}
    </div>
  );
}
