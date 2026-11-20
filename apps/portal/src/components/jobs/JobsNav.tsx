import Link from "next/link";
import { cn } from "@/lib/cn";
import { tJobs } from "@/i18n/jobs";

/** Board | Agents under the Jobs heading. Plain links (no Motion), so the jobs routes stay light. */
export function JobsNav({ current }: { current: "board" | "agents" }) {
  const items = [
    { id: "board", href: "/jobs", label: tJobs("nav.board") },
    { id: "agents", href: "/jobs/agents", label: tJobs("nav.agents") },
  ] as const;
  return (
    <nav aria-label={tJobs("nav.label")} className="surface-strong inline-flex w-fit rounded-chip p-1">
      <ul className="flex items-center gap-0.5">
        {items.map((i) => (
          <li key={i.id}>
            <Link
              href={i.href}
              aria-current={current === i.id ? "page" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-chip px-4 text-sm tracking-tight",
                current === i.id ? "bg-pill-active font-bold text-ink ring-1 ring-accent-strong/30" : "font-medium text-ink-muted hover:text-ink",
              )}
            >
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
