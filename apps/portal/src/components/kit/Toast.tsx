"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

// Motion (spring in, quick fade out) loads with the first toast, not with every page.
const ToastViewport = dynamic(() => import("./ToastViewport"), { ssr: false });

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastData {
  id: string;
  tone: ToastTone;
  title: string;
  body?: string;
}

const toneMeta = {
  info: { icon: Info, color: "text-accent-strong" },
  success: { icon: CheckCircle2, color: "text-ok" },
  warning: { icon: TriangleAlert, color: "text-warn" },
  error: { icon: AlertTriangle, color: "text-err" },
} as const;

/** Presentational toast: also rendered statically in the gallery. */
export function ToastView({
  tone,
  title,
  body,
  onClose,
  className,
}: Omit<ToastData, "id"> & { onClose?: () => void; className?: string }) {
  const { icon: Icon, color } = toneMeta[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("surface-strong flex w-full max-w-sm items-start gap-3 p-3.5 shadow-[var(--shadow-pop)]", className)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", color)} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold tracking-tight">
          <span className="sr-only">{t(`toast.${tone}`)}: </span>
          {title}
        </p>
        {body && <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{body}</p>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("toast.close")}
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-accent-soft hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}

interface ToastApi {
  push: (toast: Omit<ToastData, "id">) => void;
}
const ToastContext = React.createContext<ToastApi>({ push: () => {} });
export const useToast = () => React.useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);
  // Stays true once a toast has been shown, so the last one can still animate out.
  const [used, setUsed] = React.useState(false);
  const dismiss = React.useCallback((id: string) => setToasts((l) => l.filter((x) => x.id !== id)), []);

  const push = React.useCallback(
    (toast: Omit<ToastData, "id">) => {
      const id = crypto.randomUUID();
      setToasts((l) => [...l.slice(-3), { ...toast, id }]);
      setUsed(true);
      // Errors stay until dismissed; everything else clears itself.
      if (toast.tone !== "error") window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const api = React.useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label={t("toast.region")}
        className="pointer-events-none fixed inset-x-4 bottom-20 z-50 grid justify-items-end gap-2 md:bottom-6 md:right-6 md:left-auto"
      >
        {used && <ToastViewport toasts={toasts} dismiss={dismiss} />}
      </section>
    </ToastContext.Provider>
  );
}
