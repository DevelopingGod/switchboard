"use client";

import { Segmented } from "@/components/kit/Segmented";
import { ExplainPopover } from "@/components/kit/ExplainPopover";
import { setPrefs, usePrefs, type Mode } from "@/lib/prefs";
import { t } from "@/i18n/strings";

export function ModeSwitch() {
  const { mode } = usePrefs();
  return (
    <div className="flex items-center gap-1">
      <Segmented<Mode>
        label={t("mode.label")}
        value={mode}
        onChange={(m) => setPrefs({ mode: m })}
        options={[
          { value: "simple", label: t("mode.simple"), hint: t("mode.simpleHint") },
          { value: "pro", label: t("mode.pro"), hint: t("mode.proHint") },
        ]}
      />
      <ExplainPopover topic={t("mode.label")} className="max-2xl:hidden">
        <p>{t("mode.simpleHint")}</p>
        <p className="mt-1">{t("mode.proHint")}</p>
      </ExplainPopover>
    </div>
  );
}
