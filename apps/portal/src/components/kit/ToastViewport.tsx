"use client";

import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { shared } from "@/design/design-tokens";
import { MotionScope } from "./MotionScope";
import { type ToastData, ToastView } from "./Toast";

/** The animated toast list. Loaded the first time a toast is pushed (it carries Motion). */
export default function ToastViewport({ toasts, dismiss }: { toasts: ToastData[]; dismiss: (id: string) => void }) {
  return (
    <MotionScope>
      <AnimatePresence>
        {toasts.map((x) => (
          <m.div
            key={x.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
            transition={{ type: "spring", ...shared.spring }}
            className="pointer-events-auto w-full max-w-sm"
          >
            <ToastView {...x} onClose={() => dismiss(x.id)} />
          </m.div>
        ))}
      </AnimatePresence>
    </MotionScope>
  );
}
