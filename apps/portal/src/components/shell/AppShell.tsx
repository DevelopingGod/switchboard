"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { LazyMotion, MotionConfig } from "motion/react";
import { SkyBackground } from "@/components/kit/SkyBackground";
import { ToastProvider } from "@/components/kit/Toast";
import { TopNav } from "./TopNav";
import { MobileNav } from "./MobileNav";
import { usePrefs } from "@/lib/prefs";
import { t } from "@/i18n/strings";

// The palette (cmdk + Radix Dialog) is loaded the first time it is opened, keeping it out of the initial JS.
const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), { ssr: false });
const loadMotionFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/** Scrollbars, tooltips and the ambient cursor: plain DOM, installed once the page is idle. */
function useEnhancements() {
  React.useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    const start = () =>
      import("@/lib/enhance").then((m) => {
        if (!cancelled) off = m.install();
      });
    const idle = window.requestIdleCallback?.(start, { timeout: 1500 }) ?? window.setTimeout(start, 300);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      off?.();
    };
  }, []);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { motion } = usePrefs();
  useEnhancements();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteMounted, setPaletteMounted] = React.useState(false);
  const openPalette = React.useCallback((open: boolean) => {
    if (open) setPaletteMounted(true);
    setPaletteOpen(open);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPalette]);

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion={motion === "reduce" ? "always" : "user"}>
      <ToastProvider>
        <SkyBackground />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-chip focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-on-accent"
        >
          {t("nav.skip")}
        </a>
        <TopNav onOpenPalette={() => openPalette(true)} />
        <main id="main" className="mx-auto w-full max-w-[88rem] px-3 pt-8 pb-28 sm:px-5 md:pb-16">
          {children}
        </main>
        <MobileNav />
        {paletteMounted && <CommandPalette open={paletteOpen} onOpenChange={openPalette} />}
      </ToastProvider>
      </MotionConfig>
    </LazyMotion>
  );
}
