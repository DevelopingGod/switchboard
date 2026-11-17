import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Original columns artwork for onboarding and login only. Five fluted columns under a
 * shared entablature, drawn from simple geometry; decorative (aria-hidden).
 */
export function ColumnsArt({ className }: { className?: string }) {
  const id = React.useId();
  const xs = [34, 98, 162, 226, 290];
  return (
    <svg viewBox="0 0 360 220" aria-hidden className={cn("w-full max-w-md", className)} fill="none">
      <defs>
        <linearGradient id={`${id}-shaft`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#8b8fe8" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`${id}-top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#d9dbff" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      <rect x="10" y="14" width="340" height="16" rx="8" fill={`url(#${id}-top)`} />
      <rect x="22" y="30" width="316" height="9" rx="4.5" fill="#ffffff" fillOpacity="0.55" />
      {xs.map((x, i) => (
        <g key={x} transform={`translate(${x} 0)`}>
          <rect x="-2" y="39" width="40" height="10" rx="5" fill={`url(#${id}-top)`} />
          <rect x="2" y="49" width="32" height="132" rx="4" fill={`url(#${id}-shaft)`} />
          {[10, 18, 26].map((fx) => (
            <path key={fx} d={`M${fx} 54V176`} stroke="#8b8fe8" strokeOpacity={i % 2 ? 0.28 : 0.2} strokeWidth="1.5" />
          ))}
          <rect x="-2" y="181" width="40" height="10" rx="5" fill={`url(#${id}-top)`} />
        </g>
      ))}
      <rect x="10" y="191" width="340" height="16" rx="8" fill={`url(#${id}-top)`} />
    </svg>
  );
}
