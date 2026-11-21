import type { Metadata } from "next";
import { SettingsScreen } from "@/components/settings/SettingsScreen";
import { loadOnboarding, loadSettings } from "@/lib/server/data";
import { routerGet, routerGetAdmin } from "@/lib/server/router";
import type { LocalProfileView, SystemSummary } from "@/lib/router-types";
import type { SubscriptionItem } from "@/lib/metrics-types";
import { tSet } from "@/i18n/settings";

export const metadata: Metadata = { title: tSet("title") };

export default async function Page() {
  const [ob, settings, summary, local, subs] = await Promise.all([
    loadOnboarding(),
    loadSettings(),
    routerGet<SystemSummary>("/system/summary"),
    routerGet<LocalProfileView>("/system/local-profile"),
    routerGetAdmin<{ items: SubscriptionItem[] }>("/settings/subscriptions"),
  ]);
  const state = ob.ok ? ob.data.state : null;
  return (
    <div className="mx-auto grid max-w-[68rem] gap-8">
      <header className="grid gap-3">
        <h1 className="display">{tSet("title")}</h1>
        <p className="max-w-2xl text-lg text-ink-muted">{tSet("intro")}</p>
      </header>
      <SettingsScreen
        data={{
          name: state?.name ?? "",
          goals: state?.goals ?? [],
          preset: state?.preset ?? "balanced",
          available: ob.ok ? Object.keys(ob.data.goals) : [],
          settings: settings.ok ? settings.data : null,
          spentToday: summary.ok ? summary.data.spend_today_usd : null,
          localProfile: local.ok ? local.data : null,
          subscriptions: subs.ok ? subs.data.items : null,
          routerCode: ob.ok ? null : (ob.code ?? "router_down"),
        }}
      />
    </div>
  );
}
