import Link from "next/link";
import { tMet } from "@/i18n/metrics";
import { cn } from "@/lib/cn";

/** Overview | Activity under Metrics (M2.5). Plain links (no animation library), the current one marked. */
export function MetricsTabs({ current }: { current: "overview" | "activity" }) {
  const item = (id: "overview" | "activity", href: string) => (
    <Link
      href={href}
      aria-current={current === id ? "page" : undefined}
      className={cn(
        "inline-flex min-h-9 items-center rounded-chip px-4 text-sm font-semibold",
        current === id ? "bg-pill-active text-ink ring-1 ring-accent-strong/30" : "text-ink-muted hover:bg-pill-active hover:text-ink",
      )}
    >
      {tMet(`tabs.${id}`)}
    </Link>
  );
  return (
    <nav aria-label={tMet("tabs.label")} className="glass inline-flex w-fit gap-1 rounded-chip! p-1">
      {item("overview", "/metrics")}
      {item("activity", "/metrics/activity")}
    </nav>
  );
}
