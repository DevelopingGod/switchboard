"use client";

import { SlidersHorizontal } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/kit/Segmented";
import { setPrefs, usePrefs, type Density, type ThemePref } from "@/lib/prefs";
import { t } from "@/i18n/strings";

export default function AppearanceMenuImpl() {
  const p = usePrefs();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="glass" size="icon" aria-label={t("appearance.open")}>
          <SlidersHorizontal aria-hidden className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={t("appearance.open")} align="end" className="grid w-80 gap-4">
        <div className="grid gap-1.5">
          <span className="label">{t("appearance.theme")}</span>
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
        </div>
        <div className="grid gap-1.5">
          <span className="label">{t("appearance.density")}</span>
          <Segmented<Density>
            label={t("appearance.density")}
            value={p.density}
            onChange={(density) => setPrefs({ density })}
            options={[
              { value: "comfortable", label: t("appearance.comfortable") },
              { value: "compact", label: t("appearance.compact") },
            ]}
          />
        </div>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-semibold">{t("appearance.solid")}</span>
            <span className="block text-sm text-ink-muted">{t("appearance.solidHint")}</span>
          </span>
          <Switch checked={p.solid} onCheckedChange={(solid) => setPrefs({ solid })} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-semibold">{t("appearance.skyImage")}</span>
            <span className="block text-sm text-ink-muted">{t("appearance.skyImageHint")}</span>
          </span>
          <Switch checked={p.skyImage} onCheckedChange={(skyImage) => setPrefs({ skyImage })} />
        </label>
      </PopoverContent>
    </Popover>
  );
}
