import type * as React from "react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { t, type StringKey } from "@/i18n/strings";

/** Placeholder for screens that land in later milestones. */
export function ScreenStub({ titleKey, bodyKey, icon }: { titleKey: StringKey; bodyKey: StringKey; icon: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="display">{t(titleKey)}</h1>
      <GlassPanel as="section" tone="strong">
        <EmptyState title={t("screens.comingSoon")} body={t(bodyKey)} icon={icon} />
      </GlassPanel>
    </div>
  );
}
