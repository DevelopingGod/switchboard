"use client";

import * as React from "react";
import { RouteChip } from "@/components/kit/RouteChip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { chipTarget, ms, usd } from "@/lib/chat-format";
import type { RouteInfo } from "@/lib/router-types";
import { t, type StringKey } from "@/i18n/strings";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1">
      <dt className="label pt-0.5">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Height the popover needs to show without scrolling (it scrolls inside if it gets less). */
const NEED_PX = 380;
const GAP = 12;

/**
 * Placement that never covers the previous message (M1.5). The chip sits at the bottom of its
 * reply, so the popover opens below it (over later content or the composer). It opens above only
 * when it fits inside its own reply. When neither fits (the last reply, just above the sticky
 * composer), a spacer under the conversation (#chat-spacer) makes room and the page scrolls the
 * chip up, so it still opens below. Radix's own flipping is off: it used to flip upward over the
 * previous message.
 */
function place(chip: HTMLElement): { side: "top" | "bottom"; top: number } {
  const r = chip.getBoundingClientRect();
  const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  const top = Math.max(0, headerBottom) + 8;
  const reply = chip.closest("[data-reply]")?.getBoundingClientRect();
  const need = Math.min(NEED_PX, window.innerHeight * 0.6);
  const below = window.innerHeight - r.bottom - GAP;
  if (below >= need) return { side: "bottom", top };
  const aboveOwn = r.top - Math.max(reply?.top ?? r.top, top) - GAP;
  if (aboveOwn >= need) return { side: "top", top };
  const spacer = document.getElementById("chat-spacer");
  if (spacer) spacer.style.height = `${Math.ceil(need)}px`;
  window.scrollBy({ top: Math.ceil(need - below), behavior: "instant" });
  return { side: "bottom", top };
}

/** "Why this?" (SPEC §6.4, §8b): rule, model, top reasons, runner-up, skips, tokens, cost, latency. */
export default function WhyPopoverImpl({ route, openOnMount = false }: { route: RouteInfo; openOnMount?: boolean }) {
  const free = route.cost_usd === 0;
  const chip = React.useRef<HTMLButtonElement>(null);
  const [open, setOpen] = React.useState(false);
  const [placement, setPlacement] = React.useState<{ side: "top" | "bottom"; top: number }>({ side: "bottom", top: 8 });
  const onOpenChange = (next: boolean) => {
    if (next && chip.current) setPlacement(place(chip.current));
    if (!next) {
      const spacer = document.getElementById("chat-spacer");
      if (spacer) spacer.style.height = "0px";
    }
    setOpen(next);
  };
  // The stand-in chip was clicked before this chunk loaded: open now, focus on the real trigger.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!openOnMount || opened.current || !chip.current) return;
    opened.current = true;
    chip.current.focus();
    setPlacement(place(chip.current));
    setOpen(true);
  }, [openOnMount]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <RouteChip ref={chip} target={chipTarget(route)} rule={route.rule} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={placement.side}
        avoidCollisions={false}
        collisionPadding={{ top: placement.top, bottom: GAP, left: GAP, right: GAP }}
        data-side-chosen={placement.side}
        // It scrolls when the space is short: keyboard users must be able to scroll it too.
        tabIndex={0}
        className="max-h-[min(var(--radix-popover-content-available-height),36rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto bg-(--surface-solid)"
        aria-label={t("route.title")}
      >
        <p className="mb-2 font-semibold tracking-tight">{t("route.title")}</p>
        <dl className="text-[0.8125rem]">
          <Row label={t("route.rule")}>
            <span className="font-mono">{route.rule}</span>{" "}
            <span className="text-ink-muted">({t(`route.matched.${route.matched_by}` as StringKey)})</span>
          </Row>
          {route.label && (
            <Row label={t("route.model")}>
              {route.provider_name ?? route.label}
              {route.model && <span className="block font-mono text-xs text-ink-muted">{route.model}</span>}
            </Row>
          )}
          {route.reasons.length > 0 && (
            <Row label={t("route.reasons")}>
              <ol className="list-decimal space-y-0.5 pl-4">
                {route.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ol>
            </Row>
          )}
          <Row label={t("route.runnerUp")}>{route.runner_up ?? t("route.noRunnerUp")}</Row>
          {route.skipped.length > 0 && (
            <Row label={t("route.skipped")}>
              <ul className="space-y-1">
                {route.skipped.map((s) => (
                  <li key={s.target + s.code}>
                    <span className="font-semibold">{s.label}</span> <span className="text-ink-muted">· {s.reason}</span>
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {route.tokens_in != null && (
            <Row label={t("route.tokens")}>
              {t("route.tokensValue", { in: route.tokens_in, out: route.tokens_out ?? 0 })}
              {route.estimated && <span className="text-ink-muted"> {t("route.estimated")}</span>}
            </Row>
          )}
          {route.context_tokens > 0 && <Row label={t("route.context")}>{t("route.contextValue", { n: route.context_tokens })}</Row>}
          {route.cost_usd != null && (
            <Row label={t("route.cost")}>
              {free ? (route.list_price_usd ? t("route.freeValue", { value: usd(route.list_price_usd) }) : t("route.free")) : usd(route.cost_usd)}
            </Row>
          )}
          {route.latency_ms != null && (
            <Row label={t("route.latency")}>{t("route.latencyValue", { total: ms(route.latency_ms), ttft: ms(route.ttft_ms) })}</Row>
          )}
        </dl>
        {route.request_id != null && <p className="mt-2 font-mono text-xs text-ink-muted">{t("route.request", { id: route.request_id })}</p>}
      </PopoverContent>
    </Popover>
  );
}
