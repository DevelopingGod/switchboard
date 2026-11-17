"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

/** On/off is shown by position AND a check mark, not by color alone. */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-7 w-12 shrink-0 items-center rounded-chip border border-hairline bg-track p-0.5",
      "transition-colors duration-(--d-fast) data-[state=checked]:bg-accent disabled:opacity-55 disabled:pointer-events-none",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "grid size-6 place-items-center rounded-full bg-white text-on-accent shadow-sm",
        "transition-transform duration-(--d-base) ease-(--ease) data-[state=checked]:translate-x-5",
        "[&>svg]:opacity-0 data-[state=checked]:[&>svg]:opacity-100",
      )}
    >
      <Check aria-hidden className="size-3.5" strokeWidth={3} />
    </SwitchPrimitive.Thumb>
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
