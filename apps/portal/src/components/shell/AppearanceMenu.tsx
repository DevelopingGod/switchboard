"use client";

import dynamic from "next/dynamic";
import { useHydrated } from "@/lib/use-hydrated";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/strings";

function StaticTrigger() {
  return (
    <Button variant="glass" size="icon" aria-label={t("appearance.open")} data-tip={t("appearance.open")}>
      <SlidersHorizontal aria-hidden className="size-4" />
    </Button>
  );
}

// Loads right after hydration (Radix Popover + Switch stay out of the initial JS). The identical
// static trigger also stands in while the chunk loads, so the nav never collapses (layout shift).
const Impl = dynamic(() => import("./AppearanceMenuImpl"), { ssr: false, loading: StaticTrigger });

export function AppearanceMenu() {
  const hydrated = useHydrated();
  return hydrated ? <Impl /> : <StaticTrigger />;
}
