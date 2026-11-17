"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "value"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * On/off is shown by position AND a check mark, not by color alone.
 * A native `role="switch"` button with the same DOM and data-state as the Radix Switch it replaced
 * (M2: about 4 KB gzip less on every route with a composer). Space/Enter toggle it natively.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, defaultChecked = false, onCheckedChange, onClick, ...props }, ref) => {
    const [inner, setInner] = React.useState(defaultChecked);
    const on = checked ?? inner;
    const state = on ? "checked" : "unchecked";
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={on}
        data-state={state}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented) return;
          if (checked === undefined) setInner(!on);
          onCheckedChange?.(!on);
        }}
        className={cn(
          "peer inline-flex h-7 w-12 shrink-0 items-center rounded-chip border border-hairline bg-track p-0.5",
          "transition-colors duration-(--d-fast) data-[state=checked]:bg-accent disabled:opacity-55 disabled:pointer-events-none",
          className,
        )}
        {...props}
      >
        <span
          data-state={state}
          className={cn(
            "pointer-events-none grid size-6 place-items-center rounded-full bg-white text-on-accent shadow-sm",
            "transition-transform duration-(--d-base) ease-(--ease) data-[state=checked]:translate-x-5",
            "[&>svg]:opacity-0 data-[state=checked]:[&>svg]:opacity-100",
          )}
        >
          <Check aria-hidden className="size-3.5" strokeWidth={3} />
        </span>
      </button>
    );
  },
);
Switch.displayName = "Switch";
