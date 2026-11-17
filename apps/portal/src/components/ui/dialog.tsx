"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/** Modal on a near-opaque surface (text lives on it). `closable={false}` hides the X while work is running. */
export function DialogContent({
  className,
  children,
  closable = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { closable?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(10,10,40,0.35)] animate-[fade_var(--d-base)_ease-out]" />
      <DialogPrimitive.Content
        className={cn(
          "surface-strong fixed top-[6vh] left-1/2 z-50 grid max-h-[88vh] w-[min(94vw,40rem)] -translate-x-1/2 gap-4 overflow-y-auto p-5 shadow-[var(--shadow-pop)] animate-[pop_var(--d-base)_var(--ease)] sm:p-6",
          className,
        )}
        {...props}
      >
        {children}
        {closable && (
          <DialogPrimitive.Close
            aria-label={t("a11y.close")}
            className="absolute top-3 right-3 grid size-8 place-items-center rounded-full text-ink-muted hover:bg-accent-soft hover:text-ink"
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
