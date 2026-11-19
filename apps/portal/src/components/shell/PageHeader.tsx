"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useHydrated } from "@/lib/use-hydrated";
import { navItems } from "./nav-items";
import { t } from "@/i18n/strings";
import { tShell } from "@/i18n/shell";

const SLOT = "page-actions";

/** Slim page header (M3b): the menu button on phones, the section name, and a slot for page actions. */
export const PageHeader = React.forwardRef<HTMLButtonElement, { onOpenMenu: () => void; menuOpen: boolean }>(
  function PageHeader({ onOpenMenu, menuOpen }, menuRef) {
    const pathname = usePathname();
    const seg = pathname.split("/")[1] ?? "";
    const nav = navItems.find((i) => i.id === seg);
    const title = nav ? t(nav.label) : seg === "settings" ? t("nav.settings") : seg === "" ? t("nav.home") : t("app.name");
    return (
      <header className="page-header">
        <button
          ref={menuRef}
          type="button"
          onClick={onOpenMenu}
          aria-label={tShell("sidebar.openMenu")}
          aria-expanded={menuOpen}
          aria-controls="app-sidebar"
          className="page-menu sb-icon"
        >
          <Menu aria-hidden className="size-4" />
        </button>
        {/* Not a heading: every page keeps its own h1. */}
        <p className="page-title">{title}</p>
        <div id={SLOT} role="group" aria-label={tShell("page.actions")} className="page-actions" />
      </header>
    );
  },
);

/** Renders its children into the page header's action slot (once the header has mounted). */
export function PageActions({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const el = hydrated ? document.getElementById(SLOT) : null;
  return el ? createPortal(children, el) : null;
}
