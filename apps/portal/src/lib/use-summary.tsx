"use client";

import * as React from "react";
import type { SystemSummary } from "@/lib/router-types";

const POLL_MS = 60_000;

interface SummaryState {
  data: SystemSummary | null;
  failed: boolean;
}

const Ctx = React.createContext<SummaryState>({ data: null, failed: false });
export const useSummary = () => React.useContext(Ctx);

/**
 * One poll of /api/status every 60 s while the tab is visible, shared by the sidebar (budget dial,
 * health dot) and the footer (quota, value saved, version). Null until the first answer.
 */
export function SummaryProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SummaryState>({ data: null, failed: false });
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
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
