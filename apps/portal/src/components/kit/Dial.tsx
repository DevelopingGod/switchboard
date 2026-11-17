"use client";

import * as React from "react";
import { useReducedMotion, useSpring, useTransform } from "motion/react";
import * as m from "motion/react-m";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import { shared } from "@/design/design-tokens";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { t } from "@/i18n/strings";

const START = 135; // degrees, SVG space (0° = +x, clockwise)
const SWEEP = 270;

const rad = (d: number) => (d * Math.PI) / 180;
const pt = (c: number, r: number, deg: number) => [c + r * Math.cos(rad(deg)), c + r * Math.sin(rad(deg))] as const;

export interface DialProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Snapped, labelled stops (value is the index). Used by the autonomy selector. */
  stops?: readonly string[];
  /** Interactive when provided; otherwise a read-only meter. */
  onChange?: (value: number) => void;
  label: string;
  valueText?: string;
  size?: number;
  state?: "default" | "loading" | "error" | "disabled";
  className?: string;
  /** Centre content (number, icon…). */
  children?: React.ReactNode;
}

/**
 * Signature component: a 270° ring with a periwinkle arc and a dot handle.
 * Meter for quotas and budgets, slider for the autonomy selector.
 */
export function Dial({
  value,
  min = 0,
  max = 100,
  step = 1,
  stops,
  onChange,
  label,
  valueText,
  size = 120,
  state = "default",
  className,
  children,
}: DialProps) {
  const lo = stops ? 0 : min;
  const hi = stops ? stops.length - 1 : max;
  const stepSize = stops ? 1 : step;
  const clamped = Math.min(hi, Math.max(lo, value));
  const frac = hi === lo ? 0 : (clamped - lo) / (hi - lo);

  const interactive = !!onChange && state !== "disabled" && state !== "loading";
  const reduce = useReducedMotion();
  const f = useSpring(frac, shared.spring);
  React.useEffect(() => {
    if (reduce) f.jump(frac);
    else f.set(frac);
  }, [frac, reduce, f]);

  const stroke = Math.max(6, size * 0.085);
  const c = size / 2;
  const r = c - stroke / 2 - 4;
  const [x0, y0] = pt(c, r, START);
  const [x1, y1] = pt(c, r, START + SWEEP);
  const arc = `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`;
  const dotX = useTransform(f, (v) => pt(c, r, START + SWEEP * v)[0]);
  const dotY = useTransform(f, (v) => pt(c, r, START + SWEEP * v)[1]);

  const ref = React.useRef<SVGSVGElement>(null);
  const dragging = React.useRef(false);

  const commit = (v: number) => {
    const snapped = Math.round((v - lo) / stepSize) * stepSize + lo;
    const next = Math.min(hi, Math.max(lo, snapped));
    if (next !== clamped) onChange?.(next);
  };

  const fromPointer = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    let rel = (deg - START + 720) % 360;
    if (rel > SWEEP) rel = rel - SWEEP > (360 - SWEEP) / 2 ? 0 : SWEEP; // dead zone snaps to nearest end
    commit(lo + (rel / SWEEP) * (hi - lo));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactive) return;
    const big = stepSize * 10;
    const map: Record<string, number> = {
      ArrowRight: clamped + stepSize,
      ArrowUp: clamped + stepSize,
      ArrowLeft: clamped - stepSize,
      ArrowDown: clamped - stepSize,
      PageUp: clamped + big,
      PageDown: clamped - big,
      Home: lo,
      End: hi,
    };
    if (e.key in map) {
      e.preventDefault();
      commit(map[e.key]);
    }
  };

  if (state === "loading") {
    return (
      <div className={cn("relative grid place-items-center", className)} style={{ width: size, height: size }} aria-busy>
        <Skeleton className="rounded-full" style={{ width: size, height: size }} />
        <LoadingLabel />
      </div>
    );
  }

  const text = valueText ?? (stops ? stops[clamped] : `${Math.round(clamped)}`);
  const isErr = state === "error";
  const arcColor = isErr ? "var(--err)" : "var(--accent-strong)";

  return (
    <div
      className={cn("relative inline-grid place-items-center", state === "disabled" && "opacity-55", className)}
      style={{ width: size, height: size }}
    >
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role={interactive ? "slider" : "meter"}
        tabIndex={interactive ? 0 : undefined}
        aria-label={label}
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-valuenow={clamped}
        aria-valuetext={isErr ? `${label}: ${t("state.error")}` : text}
        aria-disabled={state === "disabled" || undefined}
        aria-invalid={isErr || undefined}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (!interactive) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        className={cn("overflow-visible touch-none", interactive && "cursor-grab active:cursor-grabbing rounded-full")}
      >
        <path d={arc} fill="none" stroke="var(--track)" strokeWidth={stroke} strokeLinecap="round" />
        {stops &&
          stops.map((_, i) => {
            const [sx, sy] = pt(c, r, START + (SWEEP * i) / (stops.length - 1));
            return <circle key={i} cx={sx} cy={sy} r={stroke * 0.22} fill="var(--ink-muted)" opacity={0.7} />;
          })}
        <m.path
          d={arc}
          fill="none"
          stroke={arcColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{ pathLength: f }}
        />
        <m.circle
          cx={dotX}
          cy={dotY}
          r={stroke * 0.95}
          fill={arcColor}
          stroke="var(--glass-strong)"
          strokeWidth={Math.max(2, stroke * 0.3)}
        />
      </svg>
      <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        {isErr ? (
          <AlertTriangle className="text-err" style={{ width: size * 0.26, height: size * 0.26 }} />
        ) : (
          (children ?? <span className="stat-value" style={{ fontSize: size * 0.24 }}>{stops ? clamped : text}</span>)
        )}
      </div>
    </div>
  );
}
