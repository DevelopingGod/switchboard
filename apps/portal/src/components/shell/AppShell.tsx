"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { LazyMotion, MotionConfig } from "motion/react";
import { SkyBackground } from "@/components/kit/SkyBackground";
import { ToastProvider } from "@/components/kit/Toast";
import { TopNav } from "./TopNav";
import { MobileNav } from "./MobileNav";
import { AppFooter } from "./AppFooter";
import { ShellContext } from "./shell-context";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { matchShortcut } from "@/lib/shortcuts";
import { t } from "@/i18n/strings";

// Overlays load the first time they are opened, keeping them out of the initial JS.
const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), { ssr: false });
const ShortcutsSheet = dynamic(() => import("./ShortcutsSheet").then((m) => m.ShortcutsSheet), { ssr: false });
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

/** The first-load splash (layout.tsx + globals.css) fades out as soon as the app is interactive. */
function useSplashOut() {
  React.useEffect(() => {
    const el = document.documentElement;
    if (!el.hasAttribute("data-splash")) return;
    el.setAttribute("data-splash", "out");
    const id = window.setTimeout(() => el.removeAttribute("data-splash"), 250);
    return () => window.clearTimeout(id);
  }, []);
}

/** Overlay that mounts on first open and stays mounted (so it can animate closed). */
function useOverlay() {
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const change = React.useCallback((next: boolean) => {
    if (next) setMounted(true);
    setOpen(next);
  }, []);
  return { open, mounted, change };
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { motion } = usePrefs();
  const router = useRouter();
  useEnhancements();
  useSplashOut();
  const palette = useOverlay();
  const sheet = useOverlay();
  const { change: setPalette } = palette;
  const { change: setSheet } = sheet;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      if (!id) return;
      if (id === "palette") setPalette(true);
      else if (id === "shortcuts") setSheet(true);
      else if (id === "sidebar") setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed });
      else if (id === "newChat") router.push("/chat");
      else if (id === "focusComposer") {
        const box = document.querySelector<HTMLTextAreaElement>("textarea[data-composer]:not([readonly])");
        if (!box) return;
        box.focus();
      } else if (id === "stop") window.dispatchEvent(new Event("sb:stop"));
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setPalette, setSheet]);

  const actions = React.useMemo(
    () => ({ openPalette: () => setPalette(true), openShortcuts: () => setSheet(true) }),
    [setPalette, setSheet],
  );

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig reducedMotion={motion === "reduce" ? "always" : "user"}>
        <ShellContext.Provider value={actions}>
          <ToastProvider>
            <SkyBackground />
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-chip focus:bg-accent focus:px-4 focus:py-2 focus:font-semibold focus:text-on-accent"
            >
              {t("nav.skip")}
            </a>
            <TopNav onOpenPalette={actions.openPalette} />
            <main id="main" className="mx-auto w-full max-w-[88rem] px-3 pt-8 pb-10 sm:px-5">
              {children}
            </main>
            <AppFooter />
            <MobileNav />
            {palette.mounted && <CommandPalette open={palette.open} onOpenChange={setPalette} />}
            {sheet.mounted && <ShortcutsSheet open={sheet.open} onOpenChange={setSheet} />}
          </ToastProvider>
        </ShellContext.Provider>
      </MotionConfig>
    </LazyMotion>
  );
}
