"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { explainError, tErr, type ErrorAction } from "@/i18n/errors";

/**
 * One plain sentence and at most one action for a coded error (M1.5). The raw text (HTTP body,
 * provider or LiteLLM message) is shown only in Pro mode, collapsed under "Details". Icon + text +
 * colour, never colour alone.
 */
export function ErrorNote({
  code,
  detail,
  actions,
  busy,
  tone = "err",
  className,
  live = false,
}: {
  code: string | null | undefined;
  detail?: string | null;
  /** Handlers for the actions this place can offer; the code's default action shows if present. */
  actions?: Partial<Record<ErrorAction, () => void>>;
  busy?: boolean;
  tone?: "err" | "warn";
  className?: string;
  /** Announce it (role="alert") — for errors that appear after a user action. */
  live?: boolean;
}) {
  const { mode } = usePrefs();
  const { message, action } = explainError(code);
  const run = action ? actions?.[action] : undefined;
  return (
    <div role={live ? "alert" : undefined} className={cn("grid gap-1.5 text-sm", className)}>
      <p className={cn("flex items-start gap-1.5", tone === "err" ? "text-err" : "text-warn")}>
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span className="text-ink">{message}</span>
      </p>
      {run && action && (
        <div>
          <Button size="sm" variant="glass" loading={busy} onClick={run}>
            {busy && action === "retry_sync" ? tErr("retrying") : tErr(`action.${action}`)}
          </Button>
        </div>
      )}
      {mode === "pro" && detail && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer select-none font-semibold">{tErr("details")}</summary>
          <pre className="solid-panel mt-1 max-h-40 overflow-auto p-2 font-mono break-words whitespace-pre-wrap">{detail}</pre>
        </details>
      )}
    </div>
  );
}
