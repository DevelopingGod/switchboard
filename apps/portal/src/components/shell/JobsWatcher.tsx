"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useToast } from "@/components/kit/Toast";
import { setNeedsYou } from "@/lib/job-attention";
import { getPrefs } from "@/lib/prefs";
import type { JobGate, JobStatus } from "@/lib/router-types";
import { tShell } from "@/i18n/shell";

interface Seen {
  id: number;
  title: string;
  status: JobStatus;
  gate: JobGate | null;
  error: string | null;
}

const POLL_MS = 15_000;

/**
 * Job awareness (M4b): keeps the sidebar's "needs you" count current and announces a job that starts
 * waiting for you, finishes or fails, with a toast (approvals are the one thing allowed to interrupt,
 * SPEC §8c) and, if you turned it on in Settings → Jobs, a desktop notification. Polls a same-origin route
 * every 15 s while the page is visible; the first answer is only a baseline (no toasts for old news), and
 * nothing is announced for the job page you are looking at.
 */
export default function JobsWatcher() {
  const { push } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const path = React.useRef(pathname);
  React.useEffect(() => {
    path.current = pathname;
  }, [pathname]);

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen: Map<number, Seen> | null = null;

    const announce = (j: Seen) => {
      if (path.current === `/jobs/${j.id}`) return;
      const title =
        j.status === "needs_approval"
          ? tShell(j.gate === "diff" ? "jobs.toastDiff" : j.gate === "result" ? "jobs.toastResult" : "jobs.toastPlan", { id: j.id })
          : j.status === "done"
            ? tShell("jobs.toastDone", { id: j.id })
            : tShell("jobs.toastFailed", { id: j.id });
      push({ tone: j.status === "failed" ? "error" : j.status === "done" ? "success" : "warning", title, body: j.title });
      if (getPrefs().jobNotifications && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
        try {
          const n = new Notification(title, { body: j.title, tag: `switchboard-job-${j.id}` });
          n.onclick = () => {
            window.focus();
            router.push(`/jobs/${j.id}`);
          };
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
    };

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible" || getPrefs().jobNotifications) {
        try {
          const res = await fetch("/api/jobs/attention", { cache: "no-store" });
          const d = (await res.json()) as { ok: boolean; needs_you?: number; jobs?: Seen[] };
          if (d.ok && d.jobs) {
            setNeedsYou(d.needs_you ?? 0);
            const next = new Map(d.jobs.map((j) => [j.id, j]));
            if (seen) {
              for (const j of d.jobs) {
                const before = seen.get(j.id);
                const changed = !before || before.status !== j.status || before.gate !== j.gate;
                if (changed && (j.status === "needs_approval" || ((j.status === "done" || j.status === "failed") && before))) announce(j);
              }
            }
            seen = next;
          } else setNeedsYou(0);
        } catch {
          setNeedsYou(0); // the router is down: Status says so; try again next time
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [push, router]);

  return null;
}
