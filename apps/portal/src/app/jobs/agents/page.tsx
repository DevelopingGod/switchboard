import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { FleetScreen } from "@/components/jobs/FleetScreen";
import { JobsNav } from "@/components/jobs/JobsNav";
import { routerGetAdmin } from "@/lib/server/router";
import type { AgentsResponse, ProjectRow } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tJobs } from "@/i18n/jobs";

export const metadata: Metadata = { title: tJobs("fleet.title") };

export default async function Page() {
  await connection();
  const [agents, projects] = await Promise.all([routerGetAdmin<AgentsResponse>("/agents"), routerGetAdmin<{ projects: ProjectRow[] }>("/projects")]);
  return (
    <div className="mx-auto grid max-w-[80rem] gap-6">
      <header className="grid gap-3">
        <h1 className="display">{tJobs("fleet.title")}</h1>
        <JobsNav current="agents" />
      </header>
      {agents.ok ? (
        <FleetScreen data={agents.data} projects={projects.ok ? projects.data.projects : []} />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${agents.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/jobs/agents" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      )}
    </div>
  );
}
