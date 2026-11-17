"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { loadTargets } from "@/app/chat/actions";
import { badgesFor, privateTargets } from "@/lib/chat-targets";
import type { Badge } from "@/lib/recommend";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";
import { tChat } from "@/i18n/chat";
import { TriggerLabel, triggerClass, type TargetPickerProps } from "./TargetPicker";

interface Option {
  target: string;
  name: string;
  detail?: string;
  badges?: Badge[];
  disabledReason?: string | null;
  paid?: boolean;
  local?: boolean;
}

function OptionRow({ o, selected, onPick }: { o: Option; selected: boolean; onPick: (t: string) => void }) {
  const disabled = !!o.disabledReason;
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && onPick(o.target)}
        className={cn(
          "grid w-full grid-cols-[1rem_1fr] items-start gap-2 rounded-control px-2 py-1.5 text-left",
          disabled ? "cursor-not-allowed opacity-60" : "hover:bg-pill-active focus-visible:bg-pill-active",
        )}
      >
        {selected ? <Check aria-hidden className="mt-0.5 size-4 text-accent-strong" /> : <span />}
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-semibold">{o.name}</span>
            {o.badges?.filter((b) => !(b === "paid" && o.paid)).map((b) => (
              <span key={b} className="rounded-chip bg-accent-soft px-1.5 text-[0.6875rem] font-semibold text-accent-strong">
                {t(`badge.${b}`)}
              </span>
            ))}
            {o.paid && <span className="rounded-chip border border-hairline px-1.5 text-[0.6875rem] font-semibold">{tChat("chat.target.paid")}</span>}
            {o.local && <span className="rounded-chip border border-hairline px-1.5 text-[0.6875rem] font-semibold">{tChat("chat.target.local")}</span>}
          </span>
          {(o.disabledReason || o.detail) && (
            <span className="block truncate text-xs text-ink-muted">{o.disabledReason ?? o.detail}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export default function TargetPickerImpl({ value, onChange, privateOn, disabled, targets, onTargets }: TargetPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const fetchTargets = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await loadTargets();
    setLoading(false);
    if (r.ok) onTargets(r.data);
    else setError(r.error);
  }, [onTargets]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !targets && !loading) void fetchTargets();
  };
  const pick = (target: string) => {
    onChange(target);
    setOpen(false);
  };

  const allowed = targets && privateOn ? privateTargets(targets) : null;
  const gate = (target: string, reason?: string | null) => reason ?? (allowed && !allowed.has(target) ? tChat("chat.target.privateOnly") : null);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger disabled={disabled} className={triggerClass}>
        <TriggerLabel value={value} privateOn={privateOn} targets={targets} />
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(28rem,60vh)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto bg-(--surface-solid) p-2" aria-label={tChat("chat.target.choose")}>
        <div
          role="radiogroup"
          aria-label={tChat("chat.target.choose")}
          className="grid gap-2 text-sm"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = items[e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)];
            next?.focus();
            e.preventDefault();
          }}
        >
          <ul className="grid">
            <OptionRow o={{ target: "auto", name: tChat("chat.target.auto"), detail: tChat("chat.target.autoHint") }} selected={value === "auto"} onPick={pick} />
          </ul>
          {loading && (
            <p className="flex items-center gap-2 px-2 py-1 text-ink-muted" role="status">
              <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> {tChat("chat.target.loading")}
            </p>
          )}
          {error && (
            <p className="px-2 py-1 text-err" role="alert">
              {tChat("chat.target.failed", { reason: error })}
            </p>
          )}
          {targets && (
            <>
              <section aria-label={tChat("chat.target.aliases")}>
                <p className="label px-2 pb-1">{tChat("chat.target.aliases")}</p>
                <ul className="grid">
                  {targets.aliases.map((a) => (
                    <OptionRow
                      key={a.target}
                      o={{ target: a.target, name: a.alias, detail: a.label, disabledReason: gate(a.target, a.available ? null : a.reason), paid: a.paid, local: a.local }}
                      selected={value === a.target}
                      onPick={pick}
                    />
                  ))}
                </ul>
              </section>
              {targets.providers.map((p) => {
                const badges = badgesFor(p);
                return (
                  <section key={p.provider} aria-label={tChat("chat.target.models", { provider: p.name })}>
                    <p className="label px-2 pb-1">{tChat("chat.target.models", { provider: p.name })}</p>
                    <ul className="grid">
                      {p.models.map((m) => (
                        <OptionRow
                          key={m.target}
                          o={{ target: m.target, name: m.display_name ?? m.model_id, badges: badges.get(m.model_id), disabledReason: gate(m.target), paid: m.paid, local: p.local }}
                          selected={value === m.target}
                          onPick={pick}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
