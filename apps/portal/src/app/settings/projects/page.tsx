import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { ProjectsScreen } from "@/components/jobs/ProjectsScreen";
import { routerGet, routerGetAdmin } from "@/lib/server/router";
import type { AccountsResponse, ProjectRow, ProjectWorktrees, SettingsView } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tJobs } from "@/i18n/jobs";

export const metadata: Metadata = { title: tJobs("projects.title") };

export default async function Page() {
  await connection();
  const [projects, settings, accounts] = await Promise.all([
    routerGetAdmin<{ projects: ProjectRow[] }>("/projects"),
    routerGet<SettingsView>("/settings"),
    routerGetAdmin<AccountsResponse>("/accounts"),
  ]);
  // Each project's copies and disk use come with the page, so nothing shifts when they arrive. The list is
  // the allowlist (a handful of folders); a project hostprobe can't read shows "unknown" instead.
  const worktrees = projects.ok
    ? Object.fromEntries(
        await Promise.all(
          projects.data.projects.map(async (p) => {
            const w = await routerGetAdmin<ProjectWorktrees>(`/projects/${p.id}/worktrees`);
            return [p.id, w.ok ? w.data : null] as const;
          }),
        ),
      )
    : {};
  return (
    <div className="mx-auto grid max-w-[60rem] gap-6">
      <header className="grid gap-3">
        <p className="text-sm font-semibold text-ink-muted">
          <Link href="/settings" className="underline underline-offset-4 hover:text-ink">
            {tJobs("projects.breadcrumb")}
          </Link>
        </p>
        <h1 className="display">{tJobs("projects.title")}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{tJobs("projects.intro")}</p>
      </header>
      {projects.ok ? (
        <ProjectsScreen
          initial={projects.data.projects}
          worktrees={worktrees}
          keep={settings.ok ? settings.data.keep_worktrees_per_project : null}
          keepDefault={settings.ok ? settings.data.defaults.keep_worktrees_per_project : null}
          accounts={accounts.ok ? accounts.data.clis : []}
        />
      ) : (
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${projects.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
          />
        </GlassPanel>
      )}
    </div>
  );
}
