"use client";

import { Dial } from "@/components/kit/Dial";
import { useSummary } from "@/lib/use-summary";
import { tShell } from "@/i18n/shell";

const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** The day's budget as a small Dial, with the amount next to it when the rail is open. */
export default function SidebarBudget({ tip }: { tip: boolean }) {
  const { data } = useSummary();
  const q = data?.quota;
  const pct = q ? Math.min(100, Math.max(0, q.daily_cap_used * 100)) : 0;
  const text = q
    ? tShell("sidebar.budgetValue", { spent: money(data.spend_today_usd), cap: money(q.daily_cap_usd) })
    : tShell("sidebar.budgetUnknown");
  return (
    <div className="flex min-w-0 items-center gap-2.5" data-tip={tip ? text : undefined} tabIndex={tip ? 0 : undefined}>
      <Dial
        value={pct}
        label={tShell("sidebar.budget")}
        valueText={text}
        size={38}
        state={q ? "default" : "loading"}
        className="shrink-0"
      />
      <span className="sb-label min-w-0 text-[0.75rem] leading-tight text-ink-muted">
        <span className="block font-semibold text-ink tabular-nums">
          {q ? `${money(data.spend_today_usd)} / ${money(q.daily_cap_usd)}` : "…"}
        </span>
        {tShell("sidebar.budget")}
      </span>
    </div>
  );
}
