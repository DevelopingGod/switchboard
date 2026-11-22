"use client";

import * as React from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ActivityDetail, ActivityItem } from "@/lib/activity-types";
import { tMet } from "@/i18n/metrics";

/** "Why this?" for one Activity row: the stored routing reasons (never message text). Its own chunk. */
export default function ActivityWhy({ item, onClose }: { item: ActivityItem; onClose: () => void }) {
  const [d, setD] = React.useState<ActivityDetail | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    fetch(`/api/activity/${item.id}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ ok: boolean; data?: ActivityDetail }>)
      .then((j) => live && (j.ok ? setD(j.data!) : setFailed(true)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [item.id]);
  const route = d?.route;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(94vw,32rem)]">
        <DialogTitle className="font-display text-xl font-bold tracking-tight">{tMet("activity.detailTitle")}</DialogTitle>
        <DialogDescription className="text-sm text-ink-muted">{item.label}</DialogDescription>
        {!d && !failed ? (
          <p className="text-sm text-ink-muted">{tMet("activity.loading")}</p>
        ) : d?.kind === "job" && d.job_id ? (
          <Link href={`/jobs/${d.job_id}`} className="font-semibold text-accent-strong underline underline-offset-4">
            {tMet("activity.openJob")}
          </Link>
        ) : route && (route.reasons?.length || route.label) ? (
          <div className="grid gap-3 text-sm">
            {route.label && <p className="font-semibold">{tMet("activity.via", { model: route.label })}</p>}
            {route.reasons && route.reasons.length > 0 && (
              <ol className="grid list-decimal gap-1 pl-5">
                {route.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
            )}
            {route.skipped && route.skipped.length > 0 && (
              <div className="grid gap-1">
                <h3 className="label">{tMet("activity.skipped")}</h3>
                <ul className="grid gap-1">
                  {route.skipped.map((s) => (
                    <li key={`${s.target}-${s.code}`} className="text-ink-muted">
                      <span className="font-semibold text-ink">{s.label}</span>: {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {d?.error && <p className="text-err">{d.error}</p>}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">{d?.error ?? tMet("activity.noDetail")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
