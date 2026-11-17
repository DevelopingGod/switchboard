import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Original columns artwork for onboarding and login only: a five-column colonnade with fluted,
 * slightly swelling shafts, scrolled capitals, bases, an entablature and stepped plinth.
 * Fills come from the theme tokens (glass, accent, hairline), so it reads in Day sky and Dusk.
 * Decorative (aria-hidden).
 */
export function ColumnsArt({ className }: { className?: string }) {
  const id = React.useId();
  const centres = [52, 126, 200, 274, 348];
  const stop = (offset: number, color: string, opacity: number) => (
    <stop offset={offset} style={{ stopColor: color, stopOpacity: opacity }} />
  );
  return (
    <svg viewBox="0 0 400 244" aria-hidden className={cn("w-full max-w-md", className)} fill="none">
      <defs>
        {/* Light from the upper left: bright edge, soft body, accent-tinted shadow side. */}
        <linearGradient id={`${id}-shaft`} x1="0" y1="0" x2="1" y2="0">
          {stop(0, "var(--glass-strong)", 1)}
          {stop(0.45, "var(--glass-strong)", 0.7)}
          {stop(1, "var(--accent)", 0.55)}
        </linearGradient>
        <linearGradient id={`${id}-stone`} x1="0" y1="0" x2="0" y2="1">
          {stop(0, "var(--glass-strong)", 1)}
          {stop(1, "var(--accent)", 0.3)}
        </linearGradient>
        <radialGradient id={`${id}-shadow`} cx="0.5" cy="0.5" r="0.5">
          {stop(0, "var(--accent)", 0.35)}
          {stop(1, "var(--accent)", 0)}
        </radialGradient>
      </defs>

      {/* cornice, frieze (with triglyph grooves), architrave */}
      <rect x="6" y="14" width="388" height="10" rx="5" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
      <rect x="14" y="24" width="372" height="22" rx="3" fill={`url(#${id}-shaft)`} stroke="var(--hairline)" />
      {Array.from({ length: 13 }, (_, i) => 28 + i * 28).map((x) => (
        <g key={x} stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1.5">
          <path d={`M${x} 29V41`} />
          <path d={`M${x + 5} 29V41`} />
        </g>
      ))}
      <rect x="14" y="46" width="372" height="8" rx="3" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />

      {centres.map((cx, i) => (
        <g key={cx}>
          {/* capital: abacus, echinus, two small scrolls */}
          <rect x={cx - 21} y="54" width="42" height="7" rx="2.5" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
          <path d={`M${cx - 15} 61Q${cx - 21} 69 ${cx - 13} 73H${cx + 13}Q${cx + 21} 69 ${cx + 15} 61Z`} fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
          <circle cx={cx - 15} cy="66" r="2.6" stroke="var(--accent)" strokeOpacity="0.5" />
          <circle cx={cx + 15} cy="66" r="2.6" stroke="var(--accent)" strokeOpacity="0.5" />
          {/* shaft with gentle entasis */}
          <path d={`M${cx - 13} 73C${cx - 15} 112 ${cx - 15} 150 ${cx - 14} 188H${cx + 14}C${cx + 15} 150 ${cx + 15} 112 ${cx + 13} 73Z`} fill={`url(#${id}-shaft)`} stroke="var(--hairline)" />
          {[-8, -2.7, 2.7, 8].map((fx) => (
            <path key={fx} d={`M${cx + fx} 77V186`} stroke="var(--accent)" strokeOpacity={i % 2 ? 0.3 : 0.22} strokeWidth="1.4" />
          ))}
          {/* base: torus and plinth */}
          <rect x={cx - 18} y="188" width="36" height="7" rx="3.5" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
          <rect x={cx - 21} y="195" width="42" height="7" rx="2.5" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
        </g>
      ))}

      {/* stepped stylobate and a soft ground shadow */}
      <rect x="8" y="202" width="384" height="8" rx="2.5" fill={`url(#${id}-stone)`} stroke="var(--hairline)" />
      <rect x="2" y="210" width="396" height="9" rx="3" fill={`url(#${id}-shaft)`} stroke="var(--hairline)" />
      <ellipse cx="200" cy="228" rx="170" ry="9" fill={`url(#${id}-shadow)`} />
    </svg>
  );
}
