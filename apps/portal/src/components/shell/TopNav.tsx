"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Search, Settings } from "lucide-react";
import { PillTabs } from "@/components/kit/PillTabs";
import { Logo } from "@/components/kit/Logo";
import { Button } from "@/components/ui/button";
import { ModeSwitch } from "./ModeSwitch";
import { AppearanceMenu } from "./AppearanceMenu";
import { activeNavId, navItems } from "./nav-items";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

export function TopNav({ onOpenPalette }: { onOpenPalette: () => void }) {
  const active = activeNavId(usePathname());
  return (
    <header className="topbar sticky top-0 z-40 px-3 pt-3 sm:px-5 sm:pt-4">
      <div className="mx-auto flex max-w-[88rem] items-center gap-2 sm:gap-3">
        <Link href="/" aria-label={t("logo.alt")} className="rounded-chip pr-2">
          <Logo className="[&>span]:max-lg:hidden" />
        </Link>

        <div className="mx-auto hidden md:block">
          <PillTabs items={navItems} value={active} label={t("nav.label")} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenPalette}
            aria-keyshortcuts="Control+K Meta+K"
            className="surface-strong inline-flex min-h-(--ctl) items-center gap-2 whitespace-nowrap rounded-chip px-3.5 text-sm text-ink-muted transition-transform duration-(--d-fast) hover:text-ink active:scale-[0.97]"
          >
            <Search aria-hidden className="size-4" />
            <span className="sr-only whitespace-nowrap min-[1500px]:not-sr-only">{t("palette.open")}</span>
            <kbd aria-hidden className="hidden rounded-md border border-hairline px-1.5 font-mono text-xs sm:inline">{t("palette.shortcut")}</kbd>
          </button>
          <ModeSwitch />
          <AppearanceMenu />
          <Link
            href="/settings"
            aria-label={t("nav.settings")}
            data-tip={t("nav.settings")}
            aria-current={active === "settings" ? "page" : undefined}
            className={cn(
              "surface-strong grid size-(--ctl) place-items-center rounded-full text-ink transition-transform duration-(--d-fast) active:scale-[0.95]",
              active === "settings" && "ring-2 ring-accent-strong",
            )}
          >
            <Settings aria-hidden className="size-4" />
          </Link>
          <Button asChild className="hidden sm:inline-flex">
            <Link href="/chat">
              <Plus aria-hidden className="size-4" />
              {t("nav.newChat")}
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
