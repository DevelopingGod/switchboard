"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Activity, BarChart3, Gauge, LayoutGrid, MessageSquare, Moon, Palette, PlugZap, Route, Settings, SquareKanban, Sun } from "lucide-react";
import { setPrefs, resolveTheme, usePrefs } from "@/lib/prefs";
import { t } from "@/i18n/strings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ic = "size-4 shrink-0 text-accent-strong";

export function CommandPalette({ open, onOpenChange }: Props) {
  const router = useRouter();
  const p = usePrefs();

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };
  const go = (href: string) => run(() => router.push(href));

  const dark = typeof window !== "undefined" && resolveTheme(p.theme) === "dark";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[rgba(10,10,40,0.35)] animate-[fade_var(--d-base)_ease-out]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface-strong fixed top-[14vh] left-1/2 z-50 w-[min(92vw,34rem)] -translate-x-1/2 overflow-hidden p-0 shadow-[var(--shadow-pop)] animate-[pop_var(--d-base)_var(--ease)]"
        >
          <Dialog.Title className="sr-only">{t("palette.title")}</Dialog.Title>
          <Command label={t("palette.title")} loop>
            <Command.Input placeholder={t("palette.placeholder")} autoFocus />
            <Command.List>
              <Command.Empty>{t("palette.empty")}</Command.Empty>
              <Command.Group heading={t("palette.groupGo")}>
                <Command.Item onSelect={go("/")}><LayoutGrid aria-hidden className={ic} />{t("nav.home")}</Command.Item>
                <Command.Item onSelect={go("/chat")}><MessageSquare aria-hidden className={ic} />{t("nav.chat")}</Command.Item>
                <Command.Item onSelect={go("/studio")}><Palette aria-hidden className={ic} />{t("nav.studio")}</Command.Item>
                <Command.Item onSelect={go("/jobs")}><SquareKanban aria-hidden className={ic} />{t("nav.jobs")}</Command.Item>
                <Command.Item onSelect={go("/connections")}><PlugZap aria-hidden className={ic} />{t("nav.connections")}</Command.Item>
                <Command.Item onSelect={go("/metrics")}><BarChart3 aria-hidden className={ic} />{t("nav.metrics")}</Command.Item>
                <Command.Item onSelect={go("/settings")}><Settings aria-hidden className={ic} />{t("nav.settings")}</Command.Item>
                <Command.Item onSelect={go("/settings/rules")}><Route aria-hidden className={ic} />{t("palette.rules")}</Command.Item>
                <Command.Item onSelect={go("/status")}><Activity aria-hidden className={ic} />{t("nav.status")}</Command.Item>
                <Command.Item onSelect={go("/dev/components")}><Gauge aria-hidden className={ic} />{t("palette.devComponents")}</Command.Item>
              </Command.Group>
              <Command.Group heading={t("palette.groupPrefs")}>
                <Command.Item
                  onSelect={run(() => setPrefs({ theme: dark ? "light" : "dark" }))}
                >
                  {dark ? <Sun aria-hidden className={ic} /> : <Moon aria-hidden className={ic} />}
                  {t("palette.toggleTheme", { theme: dark ? t("appearance.light") : t("appearance.dark") })}
                </Command.Item>
                <Command.Item onSelect={run(() => setPrefs({ density: p.density === "compact" ? "comfortable" : "compact" }))}>
                  <LayoutGrid aria-hidden className={ic} />
                  {t("palette.toggleDensity", { density: p.density === "compact" ? t("appearance.comfortable") : t("appearance.compact") })}
                </Command.Item>
                <Command.Item onSelect={run(() => setPrefs({ mode: p.mode === "pro" ? "simple" : "pro" }))}>
                  <Gauge aria-hidden className={ic} />
                  {t("palette.toggleMode", { mode: p.mode === "pro" ? t("mode.simple") : t("mode.pro") })}
                </Command.Item>
                <Command.Item onSelect={run(() => setPrefs({ solid: !p.solid }))}>
                  <Palette aria-hidden className={ic} />
                  {t("palette.toggleSolid")}
                </Command.Item>
                <Command.Item onSelect={run(() => setPrefs({ skyImage: !p.skyImage }))}>
                  <Palette aria-hidden className={ic} />
                  {t("palette.toggleSky")}
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
