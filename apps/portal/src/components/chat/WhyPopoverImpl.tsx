"use client";

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

/** "Why this?" (SPEC §6.4, §8b): rule, model, top reasons, runner-up, skips, tokens, cost, latency. */
export default function WhyPopoverImpl({ route }: { route: RouteInfo }) {
  const free = route.cost_usd === 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <RouteChip target={chipTarget(route)} rule={route.rule} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] bg-(--surface-solid)" aria-label={t("route.title")}>
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
