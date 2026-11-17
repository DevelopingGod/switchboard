"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/strings";

/** Copies text to the clipboard; says so in a polite live region (and says when it can't). */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  return (
    <>
      <Button type="button" size="sm" variant="glass" onClick={copy} className={className}>
        {state === "copied" ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        {state === "copied" ? t("copy.copied") : (label ?? t("copy.label"))}
      </Button>
      <span role="status" className="sr-only">
        {state === "copied" ? t("copy.copied") : state === "failed" ? t("copy.failed") : ""}
      </span>
    </>
  );
}
