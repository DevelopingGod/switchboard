"use client";

import dynamic from "next/dynamic";
import { useHydrated } from "@/lib/use-hydrated";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/strings";

// Loads right after hydration (Radix Popover + Switch stay out of the initial JS).
const Impl = dynamic(() => import("./AppearanceMenuImpl"), { ssr: false });

export function AppearanceMenu() {
  const hydrated = useHydrated();
  if (hydrated) return <Impl />;
  return (
    <Button variant="glass" size="icon" aria-label={t("appearance.open")}>
      <SlidersHorizontal aria-hidden className="size-4" />
    </Button>
  );
}
