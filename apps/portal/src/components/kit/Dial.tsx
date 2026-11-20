"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import { LoadingLabel } from "./Skeleton";
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
  /** Stops that can't be chosen now, with the reason (M4b: autonomy level 3 without a sandbox). The
   * handle never lands on them (keys, drag and Home/End skip to the nearest allowed stop); the caller
   * shows the reason as text next to the dial. */
  disabledStops?: Readonly<Record<number, string>>;
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
  disabledStops,
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

  const stroke = Math.max(6, size * 0.085);
  const c = size / 2;
  const r = c - stroke / 2 - 4;
  const [x0, y0] = pt(c, r, START);
  const [x1, y1] = pt(c, r, START + SWEEP);
  const arc = `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`;
  // CSS transitions, not a Motion spring (M1.5): the arc is a dash offset on a normalised path and
  // the handle rotates around the centre, so neither needs Motion's engine in first-load JS (~7.6 KB).
  // The global reduced-motion rules turn both transitions off.
  const motionStyle = { transitionDuration: "var(--d-slow)", transitionTimingFunction: "var(--ease)" } as const;

  const ref = React.useRef<SVGSVGElement>(null);
  const dragging = React.useRef(false);

  const blocked = (v: number) => !!stops && disabledStops?.[v] !== undefined;
  const commit = (v: number) => {
    const snapped = Math.round((v - lo) / stepSize) * stepSize + lo;
    let next = Math.min(hi, Math.max(lo, snapped));
    // A disabled stop: step back toward the current value until an allowed one.
    const dir = next > clamped ? -1 : 1;
    while (blocked(next) && next !== clamped) next += dir * stepSize;
    if (next !== clamped && !blocked(next)) onChange?.(next);
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
    // A shimmering ring, not a grey disc: the track plus a light arc orbiting it.
    return (
      <div className={cn("relative inline-grid place-items-center", className)} style={{ width: size, height: size }} aria-busy>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="overflow-visible">
          <path d={arc} fill="none" stroke="var(--track)" strokeWidth={stroke} strokeLinecap="round" />
          <path
            d={arc}
            pathLength={100}
            className="dial-orbit"
            fill="none"
            stroke="var(--accent)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray="22 78"
          />
        </svg>
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
            return blocked(i) ? (
              <circle key={i} cx={sx} cy={sy} r={stroke * 0.3} fill="none" stroke="var(--ink-muted)" strokeWidth={1.5} opacity={0.8} />
            ) : (
              <circle key={i} cx={sx} cy={sy} r={stroke * 0.22} fill="var(--ink-muted)" opacity={0.7} />
            );
          })}
        <path
          d={arc}
          fill="none"
          stroke={arcColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={1 - frac}
          opacity={frac > 0 ? 1 : 0}
          style={{ ...motionStyle, transitionProperty: "stroke-dashoffset" }}
        />
        <g
          style={{
            ...motionStyle,
            transitionProperty: "transform",
            transformOrigin: `${c}px ${c}px`,
            transform: `rotate(${SWEEP * frac}deg)`,
          }}
        >
          <circle
            cx={x0}
            cy={y0}
            r={stroke * 0.95}
            fill={arcColor}
            stroke="var(--glass-strong)"
            strokeWidth={Math.max(2, stroke * 0.3)}
          />
        </g>
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
