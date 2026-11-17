"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { activeNavId, navItems } from "./nav-items";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

/** Bottom bar for phones; the top pill tabs take over from tablet width. */
export function MobileNav() {
  const active = activeNavId(usePathname());
  return (
    <GlassPanel
      as="nav"
      padded={false}
      aria-label={t("nav.mobileLabel")}
      className="fixed inset-x-3 bottom-3 z-40 rounded-chip p-1 md:hidden"
    >
      <ul className="grid grid-cols-5">
        {navItems.map((i) => {
          const on = i.id === active;
          return (
            <li key={i.id}>
              <Link
                href={i.href!}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "grid min-h-12 place-items-center gap-0.5 rounded-chip py-1.5 text-[0.6875rem] tracking-tight",
                  on ? "bg-pill-active font-bold text-ink ring-1 ring-accent-strong/40" : "font-medium text-ink-muted",
                )}
              >
                {i.icon}
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </GlassPanel>
  );
}
