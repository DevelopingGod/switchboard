"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/** Counts glass layers above us so the tree never stacks more than two backdrop blurs. */
const BlurDepth = React.createContext(0);
const MAX_BLUR_LAYERS = 2;

type Tone = "glass" | "strong" | "solid";
type Tag = "div" | "section" | "article" | "header" | "nav" | "aside" | "form";

export interface GlassPanelProps extends React.HTMLAttributes<HTMLElement> {
  as?: Tag;
  /**
   * glass  – translucent container with backdrop blur (containers only, no body text on it)
   * strong – near-opaque surface for text
   * solid  – opaque panel for code, diffs and logs
   */
  tone?: Tone;
  /** 1 = 14px, 2 = 24px blur. */
  blur?: 1 | 2;
  /** Apply the density-aware padding. */
  padded?: boolean;
}

export const GlassPanel = React.forwardRef<HTMLElement, GlassPanelProps>(function GlassPanel(
  { as = "div", tone = "glass", blur = 1, padded = true, className, children, ...rest },
  ref,
) {
  const depth = React.useContext(BlurDepth);
  const Tag = as as React.ElementType;
  const overBudget = tone === "glass" && depth >= MAX_BLUR_LAYERS;

  if (overBudget && process.env.NODE_ENV !== "production") {
    console.warn("GlassPanel: a third stacked blur layer was dropped (max 2 per SPEC §8c).");
  }

  const toneClass = tone === "glass" ? "glass" : tone === "strong" ? "surface-strong" : "solid-panel";
  const node = (
    <Tag
      ref={ref}
      data-blur={tone === "glass" ? (overBudget ? "0" : String(blur)) : undefined}
      className={cn(toneClass, tone !== "solid" && "glow-edge", padded && "p-(--pad)", className)}
      {...rest}
    >
      {children}
    </Tag>
  );

  return tone === "glass" && !overBudget ? (
    <BlurDepth.Provider value={depth + 1}>{node}</BlurDepth.Provider>
  ) : (
    node
  );
});
