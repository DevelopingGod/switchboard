import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { MetricsScreen } from "@/components/metrics/MetricsScreen";
import { fixtureMode, routerGetAdmin } from "@/lib/server/router";
import { RANGE_KEYS, type MetricsSummary, type RangeKey } from "@/lib/metrics-types";
import { t } from "@/i18n/strings";
import { tMet } from "@/i18n/metrics";

export const metadata: Metadata = { title: tMet("title") };

const TZ = /^[A-Za-z0-9_+\-/]{1,64}$/;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const range: RangeKey = RANGE_KEYS.includes(one("range") as RangeKey) ? (one("range") as RangeKey) : "7d";
  // The browser's time zone, remembered in a cookie by the page itself (first visit: UTC, then corrected).
  const saved = (await cookies()).get("sb_tz")?.value;
  const tz = saved && TZ.test(saved) ? saved : "UTC";
  const q = new URLSearchParams({ range, tz });
  if (fixtureMode() && one("fixture") === "empty") q.set("empty", "1");
  const summary = await routerGetAdmin<MetricsSummary>(`/metrics/summary?${q}`);
  return (
    <div className="mx-auto grid max-w-[72rem] gap-6">
      <header className="grid gap-3">
        <h1 className="display">{tMet("title")}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{tMet("intro")}</p>
      </header>
      {summary.ok ? (
        <MetricsScreen initial={summary.data} empty={q.get("empty") === "1"} />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${summary.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/metrics" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      )}
    </div>
  );
}
