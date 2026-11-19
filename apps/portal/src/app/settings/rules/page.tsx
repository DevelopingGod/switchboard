import type { Metadata } from "next";
import Link from "next/link";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { RulesScreen } from "@/components/rules/RulesScreen";
import { routerGet } from "@/lib/server/router";
import { connection } from "next/server";
import type { RulesResponse, RulesVersionsResponse } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tRules } from "@/i18n/rules";

export const metadata: Metadata = { title: tRules("title") };

export default async function Page() {
  await connection();
  const [rules, versions] = await Promise.all([routerGet<RulesResponse>("/rules"), routerGet<RulesVersionsResponse>("/rules/versions?limit=20")]);
  return (
    <div className="mx-auto grid max-w-[88rem] gap-6">
      <header className="grid gap-3">
        <p className="text-sm font-semibold text-ink-muted">
          <Link href="/settings" className="underline underline-offset-4 hover:text-ink">
            {tRules("breadcrumb")}
          </Link>
        </p>
        <h1 className="display">{tRules("title")}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{tRules("intro")}</p>
      </header>
      {rules.ok ? (
        <RulesScreen initial={rules.data} versions={versions.ok ? versions.data : { versions: [], next_before: null }} />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${rules.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/settings/rules" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      )}
    </div>
  );
}
