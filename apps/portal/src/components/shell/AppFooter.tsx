"use client";

import { Gauge, Keyboard } from "lucide-react";
import { cn } from "@/lib/cn";
import { useSummary } from "@/lib/use-summary";
import { tShell } from "@/i18n/shell";
import { footerQuota } from "@/lib/footer-quota";
import { useShell } from "./shell-context";

const DOCS = "https://github.com/DevelopingGod/switchboard/tree/main/docs";
const REPO = "https://github.com/DevelopingGod/switchboard";

const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/**
 * Slim glass footer (M1.5, trimmed in M3b): quota, value saved, version and links. Service health and
 * today's spend moved to the sidebar (health dot, budget dial), so they are not repeated here. Fixed
 * height and reserved space, so loading never shifts the page.
 */
export function AppFooter() {
  const { data, failed } = useSummary();
  const { openShortcuts } = useShell();
  const quota = data?.quota.status;

  return (
    <footer aria-label={tShell("footer.label")} className="mx-auto w-full max-w-[88rem] px-3 pb-5 sm:px-5">
      <div className="surface-strong flex h-11 items-center gap-3 rounded-chip px-4 text-[0.8125rem] sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 text-ink-muted" aria-live="polite">
          {data ? (
            <>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 font-semibold",
                  quota === "ok" ? "text-ok" : quota === "limited" ? "text-warn" : "text-err",
                )}
                data-tip={tShell("footer.quota.tip")}
                tabIndex={0}
              >
                <Gauge aria-hidden className="size-3.5" strokeWidth={2.5} />
                <span className="truncate">{footerQuota(data.quota)}</span>
              </span>
              <span className="hidden truncate tabular-nums sm:inline" data-tip={tShell("footer.savedTip")} tabIndex={0}>
                {tShell("footer.saved", { amount: money(data.value_saved_usd) })}
              </span>
            </>
          ) : failed ? (
            <span>{tShell("footer.offline")}</span>
          ) : (
            <span aria-hidden className="shimmer h-3 w-40 rounded-chip" />
          )}
        </div>

        <nav aria-label={tShell("footer.links")} className="flex shrink-0 items-center gap-1 text-ink-muted">
          {data && <span className="hidden px-1.5 tabular-nums md:inline">{tShell("footer.version", { version: data.version })}</span>}
          <a href={DOCS} target="_blank" rel="noopener noreferrer" className="hidden rounded-chip px-1.5 py-1 font-semibold hover:text-ink sm:inline">
            {tShell("footer.docs")}
          </a>
          <a href={REPO} target="_blank" rel="noopener noreferrer" className="hidden rounded-chip px-1.5 py-1 font-semibold hover:text-ink sm:inline">
            {tShell("footer.github")}
          </a>
          <button
            type="button"
            onClick={openShortcuts}
            aria-label={tShell("footer.shortcuts")}
            data-tip={tShell("footer.shortcuts")}
            aria-keyshortcuts="?"
            className="grid size-8 place-items-center rounded-full hover:bg-accent-soft hover:text-ink"
          >
            <Keyboard aria-hidden className="size-4" />
          </button>
        </nav>
      </div>
    </footer>
  );
}
