import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft, PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { JobDetail } from "@/components/jobs/JobDetail";
import { routerGetAdmin } from "@/lib/server/router";
import type { JobDiff, JobView } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tJobs } from "@/i18n/jobs";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `${tJobs("title")} · #${id}` };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) notFound();
  const r = await routerGetAdmin<JobView>(`/jobs/${id}`);
  if (!r.ok && r.status === 404) notFound();
  // A job waiting for you to review its changes opens on them: fetch them with the page (no layout shift).
  const diff = r.ok && r.data.gate === "diff" && r.data.worktree ? await routerGetAdmin<JobDiff>(`/jobs/${id}/diff`) : null;
  // Paperclip's own UI (deep link for advanced config, SPEC §8 item 3). Loopback by default.
  const paperclipUi = (process.env.PAPERCLIP_UI_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  return (
    <div className="mx-auto grid max-w-[72rem] gap-6">
      <p className="text-sm font-semibold text-ink-muted">
        <Link href="/jobs" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-ink">
          <ArrowLeft aria-hidden className="size-4" /> {tJobs("detail.back")}
        </Link>
      </p>
      {r.ok ? (
        <JobDetail key={r.data.id} initial={r.data} paperclipUi={paperclipUi} initialDiff={diff?.ok ? diff.data : null} />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${r.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
          />
        </GlassPanel>
      )}
    </div>
  );
}
