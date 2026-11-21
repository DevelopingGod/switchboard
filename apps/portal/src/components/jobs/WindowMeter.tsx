import { Dial } from "@/components/kit/Dial";
import { sourceText, windowPct, windowText } from "@/lib/subscription-format";
import type { SubscriptionView } from "@/lib/router-types";
import { tSubs } from "@/i18n/subscriptions";

/**
 * A subscription account's usage window (M6.5): a read-only Dial (`role="meter"`) and one sentence, with
 * "reported" or "estimate" next to it. Unknown shares show a dash, never a made-up number. `pro` adds the
 * other windows (for example the 7-day one).
 */
export function WindowMeter({ sub, pro = false, size = 64 }: { sub: SubscriptionView; pro?: boolean; size?: number }) {
  const w = sub.tightest;
  const pct = windowPct(w);
  const text = windowText(w);
  const others = sub.windows.filter((x) => x.window !== w?.window);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <Dial value={pct ?? 0} label={tSubs("window.meter")} valueText={text} size={size} state={pct == null && !w?.limited ? "disabled" : "default"}>
        <span className="text-center text-[0.6875rem] leading-tight font-semibold tabular-nums">
          {w?.limited ? "100%" : pct == null ? "—" : `${w?.source === "estimate" ? "~" : ""}${pct}%`}
        </span>
      </Dial>
      <div className="grid min-w-0 gap-0.5 text-[0.8125rem]">
        <p className="font-semibold">{tSubs("account.line", { plan: sub.plan_label, account: sub.account === "default" ? tSubs("account.default") : sub.account })}</p>
        <p className={w?.limited ? "font-semibold text-warn" : "text-ink-muted"}>{text}</p>
        {w && (
          <p className="text-ink-muted" data-tip={tSubs("source.help")}>
            {sourceText(w)}
          </p>
        )}
        {pro &&
          others.map((o) => (
            <p key={o.window} className="text-ink-muted">
              {tSubs("window.other", { label: o.label, text: windowText(o) })}
            </p>
          ))}
      </div>
    </div>
  );
}
