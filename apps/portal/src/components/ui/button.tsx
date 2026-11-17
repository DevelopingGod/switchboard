import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/** shadcn/ui-style Button, retuned to the Switchboard tokens. */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "rounded-chip font-semibold tracking-tight",
    "min-h-(--ctl) px-5 text-sm",
    "transition-[transform,background-color,box-shadow,opacity] duration-(--d-fast) ease-(--ease)",
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60",
    "aria-disabled:pointer-events-none aria-disabled:opacity-60",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-on-accent shadow-[0_8px_24px_-8px_rgba(98,102,220,0.65)] hover:brightness-105",
        glass: "bg-glass-strong text-ink border border-hairline hover:bg-pill-active",
        ghost: "bg-transparent text-ink hover:bg-accent-soft",
        danger: "bg-glass-strong text-err border border-err hover:bg-accent-soft",
      },
      size: { default: "", sm: "min-h-8 px-3.5 text-[0.8125rem]", icon: "w-(--ctl) px-0" },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
            {children}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";
