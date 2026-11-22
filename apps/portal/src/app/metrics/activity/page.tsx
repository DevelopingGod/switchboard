import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ActivityScreen } from "@/components/metrics/ActivityScreen";
import { MetricsTabs } from "@/components/metrics/MetricsTabs";
import { routerGetAdmin } from "@/lib/server/router";
import type { ActivityOptions, ActivityPage } from "@/lib/activity-types";
import { t } from "@/i18n/strings";
import { tMet } from "@/i18n/metrics";

export const metadata: Metadata = { title: tMet("activity.title") };

const TZ = /^[A-Za-z0-9_+\-/]{1,64}$/;
const RANGES = new Set(["today", "7d", "30d"]);

/** Metrics → Activity (M2.5): every request in one searchable, keyset-paged list. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const r = typeof sp.range === "string" && RANGES.has(sp.range) ? sp.range : "7d";
  const saved = (await cookies()).get("sb_tz")?.value;
  const tz = saved && TZ.test(saved) ? saved : "UTC";
  const q = new URLSearchParams({ range: r, tz });
  const [page, options] = await Promise.all([
    routerGetAdmin<ActivityPage>(`/activity?${q}`),
    routerGetAdmin<ActivityOptions>(`/activity/options?${q}`),
  ]);
  return (
    <div className="mx-auto grid max-w-[72rem] gap-6">
      <header className="grid gap-3">
        <h1 className="display">{tMet("title")}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{tMet("activity.intro")}</p>
        <MetricsTabs current="activity" />
      </header>
      {page.ok ? (
        <ActivityScreen initial={page.data} options={options.ok ? options.data : { model: [], provider: [], rule: [] }} range={r} tz={tz} />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${page.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/metrics/activity" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      )}
    </div>
  );
}
