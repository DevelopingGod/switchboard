"use client";

import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SHORTCUTS, isMac, type Shortcut } from "@/lib/shortcuts";
import { tShortcuts } from "@/i18n/shortcuts";

const GROUPS: Shortcut["group"][] = ["general", "chat", "list"];

function Keys({ keys }: { keys: string[] }) {
  const mod = isMac() ? tShortcuts("mod.mac") : tShortcuts("mod.other");
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="grid min-w-7 place-items-center rounded-md border border-hairline bg-glass-strong px-1.5 py-0.5 font-mono text-xs font-semibold text-ink shadow-[inset_0_-1px_0_var(--hairline)]"
        >
          {k === "mod" ? mod : k}
        </kbd>
      ))}
    </span>
  );
}

/** Every shortcut, from the same registry the handlers use (lib/shortcuts.ts). Lazy chunk. */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,34rem)]">
        <div className="grid gap-1 pr-8">
          <DialogTitle className="font-display text-2xl font-bold tracking-tight">{tShortcuts("title")}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">{tShortcuts("description")}</DialogDescription>
        </div>
        {GROUPS.map((g) => (
          <section key={g} aria-labelledby={`sc-${g}`} className="grid gap-1.5">
            <h3 id={`sc-${g}`} className="label">
              {tShortcuts(`group.${g}`)}
            </h3>
            <dl className="grid divide-y divide-hairline rounded-control border border-hairline">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <dt>{tShortcuts(`item.${s.id}`)}</dt>
                  <dd>
                    <Keys keys={s.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
