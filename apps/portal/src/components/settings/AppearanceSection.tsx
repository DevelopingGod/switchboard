"use client";

import { Segmented } from "@/components/kit/Segmented";
import { Switch } from "@/components/ui/switch";
import { setPrefs, usePrefs, type Density, type MotionPref, type ThemePref } from "@/lib/prefs";
import { t } from "@/i18n/strings";
import { tSet } from "@/i18n/settings";
import { Field, Section } from "./Section";

function Toggle({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-[0.8125rem] text-ink-muted">{help}</span>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** Same preferences as the Appearance menu, plus motion and the ambient cursor (kept in this browser). */
export default function AppearanceSection() {
  const p = usePrefs();
  return (
    <Section id="appearance" title={tSet("section.appearance")} explain={tSet("appearance.explain")}>
      <p className="text-sm text-ink-muted">{tSet("appearance.lead")}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t("appearance.theme")}>
          <Segmented<ThemePref>
            label={t("appearance.theme")}
            value={p.theme}
            onChange={(theme) => setPrefs({ theme })}
            options={[
              { value: "system", label: t("appearance.system") },
              { value: "light", label: t("appearance.light") },
              { value: "dark", label: t("appearance.dark") },
            ]}
          />
        </Field>
        <Field label={t("appearance.density")}>
          <Segmented<Density>
            label={t("appearance.density")}
            value={p.density}
            onChange={(density) => setPrefs({ density })}
            options={[
              { value: "comfortable", label: t("appearance.comfortable") },
              { value: "compact", label: t("appearance.compact") },
            ]}
          />
        </Field>
        <Field label={tSet("appearance.motion")} help={tSet("appearance.motionHint")}>
          <Segmented<MotionPref>
            label={tSet("appearance.motion")}
            value={p.motion}
            onChange={(motion) => setPrefs({ motion })}
            options={[
              { value: "system", label: tSet("appearance.motionSystem") },
              { value: "reduce", label: tSet("appearance.motionReduce") },
            ]}
          />
        </Field>
      </div>
      <div className="grid gap-4 border-t border-hairline pt-4">
        <Toggle label={t("appearance.skyImage")} help={t("appearance.skyImageHint")} checked={p.skyImage} onChange={(skyImage) => setPrefs({ skyImage })} />
        <Toggle label={t("appearance.solid")} help={t("appearance.solidHint")} checked={p.solid} onChange={(solid) => setPrefs({ solid })} />
        <Toggle
          label={tSet("appearance.cursor")}
          help={tSet("appearance.cursorHint")}
          checked={p.ambientCursor}
          onChange={(ambientCursor) => setPrefs({ ambientCursor })}
        />
      </div>
    </Section>
  );
}
