"use client";

import * as React from "react";
import { LazyMotion, MotionConfig } from "motion/react";
import { usePrefs } from "@/lib/prefs";

const loadFeatures = () => import("@/lib/motion-features").then((m) => m.default);

/**
 * Motion is only used by the toast viewport and PillTabs, so it lives behind them instead of in the
 * app shell: no route pays its ~19 KB gzip until a toast (or a PillTabs page) needs it. Honours the
 * Appearance "reduce motion" setting on top of the OS preference.
 */
export function MotionScope({ children }: { children: React.ReactNode }) {
  const { motion } = usePrefs();
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion={motion === "reduce" ? "always" : "user"}>{children}</MotionConfig>
    </LazyMotion>
  );
}
