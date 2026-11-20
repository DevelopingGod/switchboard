import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { JobBoard } from "@/components/jobs/JobBoard";
import { JobsNav } from "@/components/jobs/JobsNav";
import { NewJobButton } from "@/components/jobs/NewJobButton";
import { routerGetAdmin } from "@/lib/server/router";
import type { AgentsResponse, JobCounts, JobsPage, ProjectRow } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tJobs } from "@/i18n/jobs";

export const metadata: Metadata = { title: tJobs("title") };

const STATUSES = new Set(["queued", "running", "needs_approval", "done", "failed", "stopped"]);

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const status = one("status") && STATUSES.has(one("status")!) ? one("status") : undefined;
  const agent = one("agent") && /^[a-z][a-z0-9-]{1,63}$/.test(one("agent")!) ? one("agent") : undefined;
  const project = one("project") && /^\d{1,9}$/.test(one("project")!) ? Number(one("project")) : undefined;
  const filter = new URLSearchParams();
  if (agent) filter.set("agent", agent);
  if (project) filter.set("project_id", String(project));
  const list = new URLSearchParams(filter);
  list.set("limit", "25");
  if (status) list.set("status", status);
  const [page, counts, agents, projects] = await Promise.all([
    routerGetAdmin<JobsPage>(`/jobs?${list}`),
    routerGetAdmin<JobCounts>(`/jobs/counts?${filter}`),
    routerGetAdmin<AgentsResponse>("/agents"),
    routerGetAdmin<{ projects: ProjectRow[] }>("/projects"),
  ]);
  return (
    <div className="mx-auto grid max-w-[72rem] gap-6">
      <header className="grid gap-3">
        <h1 className="display">{tJobs("title")}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{tJobs("intro")}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <JobsNav current="board" />
          <NewJobButton />
        </div>
      </header>
      {page.ok && counts.ok ? (
        <JobBoard
          key={`${status ?? ""}-${agent ?? ""}-${project ?? ""}`}
          initial={page.data}
          counts={counts.data}
          filters={{ status, agent, project }}
          agents={agents.ok ? agents.data.agents.map((a) => ({ id: a.id, label: a.label })) : []}
          projects={projects.ok ? projects.data.projects.map((p) => ({ id: p.id, name: p.name })) : []}
        />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${page.ok ? (counts.ok ? "" : counts.error) : page.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/jobs" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      )}
    </div>
  );
}
