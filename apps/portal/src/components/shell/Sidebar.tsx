"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Leaf, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Wrench, X } from "lucide-react";
import { LogoMark } from "@/components/kit/Logo";
import { Segmented } from "@/components/kit/Segmented";
import { cn } from "@/lib/cn";
import { getPrefs, setPrefs, usePrefs, type Mode } from "@/lib/prefs";
import { useSummary } from "@/lib/use-summary";
import { useHydrated } from "@/lib/use-hydrated";
import { useMoreBelow } from "@/lib/use-more-below";
import { useNeedsYou } from "@/lib/job-attention";
import { t } from "@/i18n/strings";
import { tShell } from "@/i18n/shell";
import { AppearanceMenu } from "./AppearanceMenu";
import { activeNavId, navItems } from "./nav-items";

// The chat list is its own chunk and mounts once the sidebar is on screen (not in the first-load JS).
const Recents = dynamic(() => import("./Recents"), {
  ssr: false,
  loading: () => (
    <div aria-hidden className="grid gap-1.5 px-1">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="shimmer h-8 rounded-control" />
      ))}
    </div>
  ),
});

// M4b: polls job states for the Jobs badge and the "needs you / done / failed" toasts; loads when idle.
const JobsWatcher = dynamic(() => import("./JobsWatcher"), { ssr: false });

// The budget dial is its own chunk (the Dial is not in the first-load JS); the placeholder is the same
// size, so nothing shifts when it arrives.
const Budget = dynamic(() => import("./SidebarBudget"), {
  ssr: false,
  loading: () => <span aria-hidden className="shimmer size-[38px] shrink-0 rounded-full" />,
});

/** True once the page is idle (or after a short timeout): the recents list loads then, not while the page is still hydrating. */
function useIdle(): boolean {
  const [idle, setIdle] = React.useState(false);
  React.useEffect(() => {
    const go = () => setIdle(true);
    const id = window.requestIdleCallback?.(go, { timeout: 1500 }) ?? window.setTimeout(go, 400);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);
  return idle;
}

const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])";

type Health = "ok" | "limited" | "down" | "unknown";

function useHealth(): Health {
  const { data, failed } = useSummary();
  const hydrated = useHydrated();
  if (!hydrated) return "unknown";
  if (failed && !data) return "down";
  if (!data) return "unknown";
  const h = data.health;
  if ([h.router, h.litellm, h.ollama, h.paperclip].some((s) => s !== "ok")) return "down";
  return data.quota.status === "ok" ? "ok" : "limited";
}

/** Breathing health dot (CSS; static under reduced motion). Opens the Status page. */
function HealthDot({ tip }: { tip: boolean }) {
  const h = useHealth();
  const text = tShell(`sidebar.health.${h}`);
  return (
    <Link
      href="/status"
      aria-label={text}
      data-tip={tip ? text : undefined}
      className="sb-health grid size-9 shrink-0 place-items-center rounded-full hover:bg-accent-soft"
    >
      <span aria-hidden data-health={h} className="sb-dot" />
    </Link>
  );
}

export function Sidebar({
  open,
  onClose,
  onOpenPalette,
}: {
  open: boolean;
  onClose: () => void;
  onOpenPalette: () => void;
}) {
  const pathname = usePathname();
  const active = activeNavId(pathname);
  const prefs = usePrefs();
  const hydrated = useHydrated();
  const idle = useIdle();
  const needsYou = useNeedsYou();
  const [query, setQuery] = React.useState(""); // the one search: it filters the chats below
  const rail = prefs.sidebarCollapsed && !open; // icon rail: tooltips stand in for the labels
  const ref = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  useMoreBelow(scrollRef);
  const toggle = () => setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed });
  const name = prefs.name.trim();

  // Drawer (phones): focus moves in, Tab stays inside, Esc closes.
  React.useEffect(() => {
    if (!open) return;
    // The drawer becomes visible on the next frame (a `visibility` transition, even a 0 s one under
    // reduced motion, starts from hidden), and a hidden element can't take focus: retry per frame.
    let tries = 0;
    let raf = 0;
    const focusClose = () => {
      closeRef.current?.focus();
      if (document.activeElement !== closeRef.current && tries++ < 5) raf = requestAnimationFrame(focusClose);
    };
    focusClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <aside
      ref={ref}
      id="app-sidebar"
      className="app-sidebar"
      data-open={open || undefined}
      data-jobs-checked={needsYou !== null || undefined}
      aria-label={tShell("sidebar.label")}
    >
      <div ref={scrollRef} className="sb-inner surface-strong">
        <div className="sb-top">
          <Link href="/" aria-label={t("logo.alt")} className="sb-logo" data-tip={rail ? t("nav.home") : undefined}>
            <LogoMark className="size-8 shrink-0" />
            <span className="sb-label font-display text-[1.25rem] font-extrabold tracking-[-0.045em]">{t("app.name")}</span>
          </Link>
          <button
            type="button"
            onClick={toggle}
            aria-label={prefs.sidebarCollapsed ? tShell("sidebar.expand") : tShell("sidebar.collapse")}
            aria-expanded={!prefs.sidebarCollapsed}
            aria-controls="app-sidebar"
            aria-keyshortcuts="Control+B Meta+B"
            data-tip={prefs.sidebarCollapsed ? tShell("sidebar.expand") : tShell("sidebar.collapse")}
            className="sb-icon sb-collapse"
          >
            {prefs.sidebarCollapsed ? <PanelLeftOpen aria-hidden className="size-4" /> : <PanelLeftClose aria-hidden className="size-4" />}
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={tShell("sidebar.closeMenu")} className="sb-icon sb-close">
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="sb-actions">
          <Link
            href="/chat"
            aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
            data-tip={rail ? t("nav.newChat") : undefined}
            className="sb-new"
          >
            <Plus aria-hidden className="size-4 shrink-0" />
            <span className="sb-label">{t("nav.newChat")}</span>
          </Link>
          {/* One search. Expanded: a field that filters the chats below, with a ⌘K button for the full
              palette (screens, commands, preferences). Rail: just the palette button. */}
          <div className="sb-field sb-full">
            <Search aria-hidden className="size-4 shrink-0 text-ink-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tShell("sidebar.searchChats")}
              aria-label={tShell("sidebar.searchChats")}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
            />
            <button
              type="button"
              onClick={onOpenPalette}
              aria-label={`${t("palette.shortcut")} ${tShell("sidebar.palette")}`}
              aria-keyshortcuts="Control+K Meta+K"
              className="rounded-md border border-hairline px-1.5 font-mono text-xs text-ink-muted hover:text-ink"
            >
              {t("palette.shortcut")}
            </button>
          </div>
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={tShell("sidebar.palette")}
            aria-keyshortcuts="Control+K Meta+K"
            data-tip={rail ? tShell("sidebar.palette") : undefined}
            className="sb-search sb-rail-only"
          >
            <Search aria-hidden className="size-4 shrink-0" />
          </button>
        </div>

        <nav aria-label={tShell("sidebar.nav")} className="sb-nav">
          <ul className="grid gap-0.5">
            {navItems.map(({ id, href, label, Icon }) => {
              const badge = id === "jobs" && needsYou ? (needsYou === 1 ? tShell("jobs.badgeOne") : tShell("jobs.badge", { n: needsYou })) : null;
              return (
                <li key={id}>
                  <Link
                    href={href}
                    aria-current={active === id ? "page" : undefined}
                    data-tip={rail ? (badge ? `${t(label)}: ${badge}` : t(label)) : undefined}
                    className="sb-link"
                  >
                    <Icon aria-hidden className="size-[1.125rem] shrink-0" />
                    <span className="sb-label">{t(label)}</span>
                    {badge && (
                      <span className="sb-badge" data-count={needsYou}>
                        {needsYou}
                        <span className="sr-only">{needsYou === 1 ? ` ${tShell("jobs.badgeRestOne")}` : ` ${tShell("jobs.badgeRest")}`}</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {idle && <JobsWatcher />}
        <section aria-label={tShell("sidebar.recents")} className="sb-recents sb-full">
          {idle && (!prefs.sidebarCollapsed || open) && (
            <React.Suspense fallback={null}>
              <Recents query={query} />
            </React.Suspense>
          )}
        </section>

        <div className="sb-bottom">
          <div className="sb-status">
            <Budget tip={rail} />
            <HealthDot tip={rail} />
          </div>
          <div className="sb-full">
            <Segmented<Mode>
              label={t("mode.label")}
              value={prefs.mode}
              onChange={(m) => setPrefs({ mode: m })}
              options={[
                { value: "simple", label: t("mode.simple"), hint: t("mode.simpleHint") },
                { value: "pro", label: t("mode.pro"), hint: t("mode.proHint") },
              ]}
              className="w-full [&>*]:flex-1"
            />
          </div>
          <button
            type="button"
            onClick={() => setPrefs({ mode: prefs.mode === "pro" ? "simple" : "pro" })}
            aria-label={tShell("sidebar.modeToggle", {
              mode: prefs.mode === "pro" ? t("mode.pro") : t("mode.simple"),
              other: prefs.mode === "pro" ? t("mode.simple") : t("mode.pro"),
            })}
            data-tip={tShell("sidebar.mode")}
            className="sb-icon sb-rail-only"
          >
            {prefs.mode === "pro" ? <Wrench aria-hidden className="size-4" /> : <Leaf aria-hidden className="size-4" />}
          </button>
          <div className="sb-foot">
            <AppearanceMenu />
            <Link
              href="/settings"
              aria-label={t("nav.settings")}
              aria-current={active === "settings" ? "page" : undefined}
              data-tip={t("nav.settings")}
              className={cn("sb-icon", active === "settings" && "ring-2 ring-accent-strong")}
            >
              <Settings aria-hidden className="size-4" />
            </Link>
            <Link
              href="/settings#profile"
              aria-label={name ? tShell("sidebar.profile", { name }) : tShell("sidebar.profileFallback")}
              data-tip={name || tShell("sidebar.profileFallback")}
              className="sb-avatar"
            >
              {(hydrated && name ? name[0] : "S").toUpperCase()}
            </Link>
          </div>
        </div>
      </div>
    </aside>
  );
}
