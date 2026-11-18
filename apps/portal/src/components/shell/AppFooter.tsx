"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, CircleDashed, Gauge, Keyboard, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useHydrated } from "@/lib/use-hydrated";
import type { SystemSummary } from "@/lib/router-types";
import { tShell } from "@/i18n/shell";
import { useShell } from "./shell-context";

const POLL_MS = 60_000;
const DOCS = "https://github.com/DevelopingGod/switchboard/tree/main/docs";
const REPO = "https://github.com/DevelopingGod/switchboard";
const DOTS = ["router", "litellm", "ollama", "paperclip"] as const;

const money = (v: number) => (v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

/** Polls /api/status every 60 s while the tab is visible; null until the first answer. */
function useSummary(): { data: SystemSummary | null; failed: boolean } {
  const [state, setState] = React.useState<{ data: SystemSummary | null; failed: boolean }>({ data: null, failed: false });
  React.useEffect(() => {
    let alive = true;
    let timer = 0;
    const load = async () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch("/api/status", { cache: "no-store" });
          const j = (await r.json()) as { ok: boolean; data?: SystemSummary };
          if (alive) setState(j.ok && j.data ? { data: j.data, failed: false } : (s) => ({ ...s, failed: true }));
        } catch {
          if (alive) setState((s) => ({ ...s, failed: true }));
        }
      }
      if (alive) timer = window.setTimeout(load, POLL_MS);
    };
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return state;
}

function Dot({ name, state }: { name: (typeof DOTS)[number]; state: "ok" | "down" | "unknown" }) {
  const label = tShell(`footer.health.${name}`);
  const text = tShell(`footer.health.${state}`, { name: label });
  const Icon = state === "ok" ? CheckCircle2 : state === "down" ? XCircle : CircleDashed;
  return (
    <li className="flex items-center gap-1" data-tip={text}>
      <Icon aria-hidden className={cn("size-3.5", state === "ok" ? "text-ok" : state === "down" ? "text-err" : "text-ink-muted")} strokeWidth={2.5} />
      <span className="sr-only">{text}</span>
      <span aria-hidden className="hidden lg:inline">
        {label}
      </span>
    </li>
  );
}

/**
 * Slim glass footer (M1.5): service health (opens /status), today's spend and value saved, quota,
 * version, links. Fixed height and reserved space, so loading never shifts the page. Collapses to an
 * icon row on small screens.
 */
export function AppFooter() {
  const hydrated = useHydrated();
  const { data, failed } = useSummary();
  const { openShortcuts } = useShell();
  const health = (k: (typeof DOTS)[number]) =>
    failed && k === "router" ? "down" : data ? (data.health[k] === "ok" ? "ok" : "down") : "unknown";
  const quota = data?.quota.status;

  return (
    <footer aria-label={tShell("footer.label")} className="mx-auto w-full max-w-[88rem] px-3 pb-24 sm:px-5 md:pb-5">
      <div className="surface-strong flex h-11 items-center gap-3 rounded-chip px-4 text-[0.8125rem] sm:gap-4">
        <Link
          href="/status"
          data-tip={tShell("footer.health.open")}
          className="-mx-1.5 flex h-8 shrink-0 items-center rounded-chip px-1.5 hover:bg-accent-soft"
        >
          {/* The link is named by its content (visible labels must be part of the name). */}
          <span className="sr-only">{tShell("footer.health.open")}: </span>
          <ul aria-label={tShell("footer.health.label")} className="flex items-center gap-2.5 font-semibold">
            {DOTS.map((k) => (
              <Dot key={k} name={k} state={hydrated ? health(k) : "unknown"} />
            ))}
          </ul>
        </Link>

        <span aria-hidden className="hidden h-4 w-px bg-hairline sm:block" />

        <div className="flex min-w-0 flex-1 items-center gap-3 text-ink-muted" aria-live="polite">
          {data ? (
            <>
              <span className="truncate tabular-nums">
                <span className="hidden sm:inline">{tShell("footer.spend", { amount: money(data.spend_today_usd) })}</span>
                <span className="sm:hidden">{money(data.spend_today_usd)}</span>
              </span>
              <span className="hidden truncate tabular-nums md:inline" data-tip={tShell("footer.savedTip")} tabIndex={0}>
                {tShell("footer.saved", { amount: money(data.value_saved_usd) })}
              </span>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 font-semibold",
                  quota === "ok" ? "text-ok" : quota === "limited" ? "text-warn" : "text-err",
                )}
                data-tip={tShell("footer.quota.tip")}
                tabIndex={0}
              >
                <Gauge aria-hidden className="size-3.5" strokeWidth={2.5} />
                <span className="max-sm:sr-only">{tShell(`footer.quota.${quota ?? "ok"}`)}</span>
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
