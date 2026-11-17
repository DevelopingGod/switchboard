"use client";

import * as React from "react";
import { Bot } from "lucide-react";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { PillTabs } from "@/components/kit/PillTabs";
import { Dial } from "@/components/kit/Dial";
import { StatCard } from "@/components/kit/StatCard";
import { RouteChip } from "@/components/kit/RouteChip";
import { ProviderCard } from "@/components/kit/ProviderCard";
import { JobCard } from "@/components/kit/JobCard";
import { CostBadge } from "@/components/kit/CostBadge";
import { ExplainPopover } from "@/components/kit/ExplainPopover";
import { Composer } from "@/components/kit/Composer";
import { ToastView, useToast } from "@/components/kit/Toast";
import { Skeleton } from "@/components/kit/Skeleton";
import { EmptyState } from "@/components/kit/EmptyState";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Logo } from "@/components/kit/Logo";
import { ColumnsArt } from "@/components/kit/ColumnsArt";
import { Button } from "@/components/ui/button";
import { strings, t } from "@/i18n/strings";

type S = "default" | "loading" | "empty" | "error" | "disabled";
const allStates: S[] = ["default", "loading", "empty", "error", "disabled"];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-testid={`cmp-${id}`} aria-labelledby={`h-${id}`} className="grid gap-4 rounded-panel p-1 [contain-intrinsic-size:auto_700px] [content-visibility:auto]">
      <h2 id={`h-${id}`} className="heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid content-start gap-2 ${className ?? ""}`}>
      <p className="label">{label}</p>
      {children}
    </div>
  );
}

const grid = "grid gap-(--gap) sm:grid-cols-2 xl:grid-cols-3";
const stateLabel = (s: S) => t(`dev.${s}`);

export function Gallery() {
  const g = strings.dev.gallery;
  const [tab, setTab] = React.useState("day");
  const [autonomy, setAutonomy] = React.useState(1);
  const [budget, setBudget] = React.useState(62);
  const { push } = useToast();

  return (
    <div className="grid gap-14">
      <header className="grid gap-3">
        <h1 className="display">{t("dev.title")}</h1>
        <p className="max-w-2xl text-lg text-ink-muted">{t("dev.intro")}</p>
      </header>

      <Section id="brand" title={g.sections.brand}>
        <div className={grid}>
          <Cell label={g.logo}><GlassPanel tone="strong"><Logo /></GlassPanel></Cell>
          <Cell label={t("dev.columnsCaption")}><GlassPanel><ColumnsArt className="text-ink" /></GlassPanel></Cell>
        </div>
      </Section>

      <Section id="glass-panel" title={g.sections.glassPanel}>
        <div className={grid}>
          <Cell label={g.glassCaption}><GlassPanel className="min-h-28"><p className="label">{g.container}</p></GlassPanel></Cell>
          <Cell label={g.strongCaption}><GlassPanel tone="strong" className="min-h-28"><p>{g.strongBody}</p></GlassPanel></Cell>
          <Cell label={g.solidCaption}>
            <GlassPanel tone="solid" className="min-h-28"><pre>{`$ ${t("dev.sampleCode")}\n${g.sampleOutput}`}</pre></GlassPanel>
          </Cell>
          <Cell label={g.nestedCaption}>
            <GlassPanel blur={2}><GlassPanel><GlassPanel className="min-h-12"><p className="label">{g.layer3}</p></GlassPanel></GlassPanel></GlassPanel>
          </Cell>
        </div>
      </Section>

      <Section id="pill-tabs" title={g.sections.pillTabs}>
        <div className={grid}>
          <Cell label={t("dev.interactive")}>
            <PillTabs label={g.tabsLabel} value={tab} onChange={setTab} items={[{ id: "day", label: g.day }, { id: "week", label: g.week }, { id: "month", label: g.month }]} />
          </Cell>
          <Cell label={t("dev.disabled")}>
            <PillTabs label={g.tabsDisabledLabel} value="day" items={[{ id: "day", label: g.day }, { id: "week", label: g.week, disabled: true }]} />
          </Cell>
        </div>
      </Section>

      <Section id="dial" title={g.sections.dial}>
        <div className="flex flex-wrap items-start gap-8">
          <Cell label={g.autonomyCaption}>
            <GlassPanel tone="strong" className="grid justify-items-center gap-2">
              <Dial size={140} stops={strings.autonomy.levels} value={autonomy} onChange={setAutonomy} label={t("composer.autonomy")} valueText={t("autonomy.valueText", { level: autonomy, name: strings.autonomy.levels[autonomy] })} />
              <p className="font-semibold">{strings.autonomy.levels[autonomy]}</p>
            </GlassPanel>
          </Cell>
          <Cell label={g.budgetCaption}>
            <GlassPanel tone="strong"><Dial size={140} value={budget} onChange={setBudget} step={5} label={g.dailyBudget} valueText={t("dev.gallery.budgetUsed", { pct: budget })}><span className="stat-value text-3xl!">{budget}%</span></Dial></GlassPanel>
          </Cell>
          <Cell label={`${t("dev.readOnly")} ${g.quota}`}>
            <GlassPanel tone="strong"><Dial size={140} value={38} label={g.quotaLeft} valueText="38%"><span className="stat-value text-3xl!">38%</span></Dial></GlassPanel>
          </Cell>
          <Cell label={t("dev.loading")}><GlassPanel tone="strong"><Dial size={140} value={0} label={g.loadingDial} state="loading" /></GlassPanel></Cell>
          <Cell label={t("dev.error")}><GlassPanel tone="strong"><Dial size={140} value={20} label={g.quotaDial} state="error" /></GlassPanel></Cell>
          <Cell label={t("dev.disabled")}><GlassPanel tone="strong"><Dial size={140} value={70} label={g.budgetDial} state="disabled" onChange={() => {}} /></GlassPanel></Cell>
        </div>
      </Section>

      <Section id="stat-card" title={g.sections.statCard}>
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <StatCard
                label={g.spendToday}
                value={g.spendValue}
                hint={t("stat.vsLast", { delta: g.spendDelta })}
                state={s}
                onRetry={() => {}}
                visual={<Dial size={84} value={62} label={g.budgetUsedLabel} valueText="62%"><span className="text-sm font-bold">62%</span></Dial>}
              />
            </Cell>
          ))}
        </div>
      </Section>

      <Section id="route-chip" title={g.sections.routeChip}>
        <div className="flex flex-wrap items-start gap-6">
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}><RouteChip target={g.routeTarget} rule={g.routeRule} state={s} onClick={() => {}} /></Cell>
          ))}
        </div>
      </Section>

      <Section id="provider-card" title={g.sections.providerCard}>
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <ProviderCard name={g.providerCli} kind="cli" status="healthy" free quotaLeft={72} lastError={s === "error" ? g.providerError : undefined} state={s} />
            </Cell>
          ))}
          <Cell label={g.warningCaption}><ProviderCard name={g.providerApi} kind="api" status="warning" quotaLeft={9} trainsOnData /></Cell>
          <Cell label={g.offlineCaption}><ProviderCard name={g.providerLocal} kind="local" status="offline" free /></Cell>
        </div>
      </Section>

      <Section id="job-card" title={g.sections.jobCard}>
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <JobCard title={g.jobFix} agent={g.routeTarget} status="running" progress={64} elapsed={g.jobElapsed} route={{ target: "claude-code", rule: "code-fix" }} cost={{ kind: "estimate", amount: g.jobEstimate }} state={s} />
            </Cell>
          ))}
          <Cell label={t("status.needsApproval")}><JobCard title={g.jobPush} agent={g.agentCodex} status="needsApproval" cost={{ kind: "free" }} /></Cell>
          <Cell label={t("status.queued")}><JobCard title={g.jobNotes} agent={g.providerCli} status="queued" /></Cell>
          <Cell label={t("status.done")}><JobCard title={g.jobSummary} agent={g.agentOpenCode} status="done" cost={{ kind: "paid", amount: g.jobPaid }} /></Cell>
        </div>
      </Section>

      <Section id="cost-badge" title={g.sections.costBadge}>
        <div className="flex flex-wrap items-start gap-6">
          <Cell label={g.costFree}><CostBadge kind="free" /></Cell>
          <Cell label={g.costPaid}><CostBadge kind="paid" amount={g.jobPaid} /></Cell>
          <Cell label={g.costEstimate}><CostBadge kind="estimate" amount={g.costEstimateAmount} /></Cell>
          <Cell label={g.costUnknown}><CostBadge kind="unknown" /></Cell>
          <Cell label={t("dev.loading")}><CostBadge kind="paid" state="loading" /></Cell>
          <Cell label={t("dev.error")}><CostBadge kind="paid" state="error" /></Cell>
          <Cell label={t("dev.disabled")}><CostBadge kind="paid" amount={g.jobPaid} state="disabled" /></Cell>
        </div>
      </Section>

      <Section id="status-badge" title={g.sections.statusBadge}>
        <GlassPanel tone="strong" className="flex flex-wrap gap-6">
          {(["healthy", "warning", "error", "offline", "queued", "running", "needsApproval", "done", "failed"] as const).map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
        </GlassPanel>
      </Section>

      <Section id="explain-popover" title={g.sections.explainPopover}>
        <div className="flex flex-wrap items-center gap-6">
          <Cell label={t("dev.default")}>
            <GlassPanel tone="strong" className="flex items-center gap-1 py-2">
              <span className="font-semibold">{g.fallbacks}</span>
              <ExplainPopover topic={g.fallbacks} title={g.fallbacksTitle} learnMoreHref="#fallbacks">
                {g.fallbacksBody}
              </ExplainPopover>
            </GlassPanel>
          </Cell>
          <Cell label={t("dev.disabled")}>
            <GlassPanel tone="strong" className="flex items-center gap-1 py-2">
              <span className="font-semibold">{g.fallbacks}</span>
              <ExplainPopover topic={g.fallbacks} disabled>{g.unused}</ExplainPopover>
            </GlassPanel>
          </Cell>
        </div>
      </Section>

      <Section id="composer" title={g.sections.composer}>
        <div className="grid gap-(--gap) xl:grid-cols-2">
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <Composer state={s} defaultValue={s === "empty" ? "" : g.composerText} disabledReason={t("home.readOnlyNote")} />
            </Cell>
          ))}
        </div>
      </Section>

      <Section id="toast" title={g.sections.toast}>
        <div className={grid}>
          <Cell label={g.toastInfo}><ToastView tone="info" title={t("dev.toastTitle")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label={g.toastSuccess}><ToastView tone="success" title={t("dev.toastTitle")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label={g.toastWarning}><ToastView tone="warning" title={t("toast.warning")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label={g.toastError}><ToastView tone="error" title={t("state.error")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
        </div>
        <div>
          <Button variant="glass" onClick={() => push({ tone: "success", title: t("dev.toastTitle"), body: t("dev.toastBody") })}>
            {t("dev.pushToast")}
          </Button>
        </div>
      </Section>

      <Section id="skeleton" title={g.sections.skeleton}>
        <GlassPanel tone="strong" className="grid max-w-md gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4 w-4/5" />
        </GlassPanel>
      </Section>

      <Section id="empty-state" title={g.sections.emptyState}>
        <div className={grid}>
          {(["default", "loading", "error", "disabled"] as const).map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <GlassPanel tone="strong">
                <EmptyState headingAs="h3" state={s} title={t("empty.jobsTitle")} body={t("empty.jobsBody")} icon={<Bot className="size-6" />} action={<Button size="sm" disabled={s === "disabled"}>{t("empty.jobsAction")}</Button>} />
              </GlassPanel>
            </Cell>
          ))}
        </div>
      </Section>
    </div>
  );
}
