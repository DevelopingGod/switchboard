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

      <Section id="brand" title="Logo and artwork">
        <div className={grid}>
          <Cell label="Logo"><GlassPanel tone="strong"><Logo /></GlassPanel></Cell>
          <Cell label={t("dev.columnsCaption")}><GlassPanel><ColumnsArt className="text-ink" /></GlassPanel></Cell>
        </div>
      </Section>

      <Section id="glass-panel" title="GlassPanel">
        <div className={grid}>
          <Cell label="glass (container, blur 1)"><GlassPanel className="min-h-28"><p className="label">Container</p></GlassPanel></Cell>
          <Cell label="strong (text surface)"><GlassPanel tone="strong" className="min-h-28"><p>Body text lives on a near-opaque surface.</p></GlassPanel></Cell>
          <Cell label="solid (code, diffs, logs)">
            <GlassPanel tone="solid" className="min-h-28"><pre>{`$ ${t("dev.sampleCode")}\n✓ 12 passed`}</pre></GlassPanel>
          </Cell>
          <Cell label="3 nested glass layers → 3rd drops its blur">
            <GlassPanel blur={2}><GlassPanel><GlassPanel className="min-h-12"><p className="label">Layer 3</p></GlassPanel></GlassPanel></GlassPanel>
          </Cell>
        </div>
      </Section>

      <Section id="pill-tabs" title="PillTabs">
        <div className={grid}>
          <Cell label={t("dev.interactive")}>
            <PillTabs label="Demo" value={tab} onChange={setTab} items={[{ id: "day", label: "Day" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }]} />
          </Cell>
          <Cell label={t("dev.disabled")}>
            <PillTabs label="Demo disabled" value="day" items={[{ id: "day", label: "Day" }, { id: "week", label: "Week", disabled: true }]} />
          </Cell>
        </div>
      </Section>

      <Section id="dial" title="Dial">
        <div className="flex flex-wrap items-start gap-8">
          <Cell label="Autonomy (interactive)">
            <GlassPanel tone="strong" className="grid justify-items-center gap-2">
              <Dial size={140} stops={strings.autonomy.levels} value={autonomy} onChange={setAutonomy} label={t("composer.autonomy")} valueText={t("autonomy.valueText", { level: autonomy, name: strings.autonomy.levels[autonomy] })} />
              <p className="font-semibold">{strings.autonomy.levels[autonomy]}</p>
            </GlassPanel>
          </Cell>
          <Cell label="Budget (interactive)">
            <GlassPanel tone="strong"><Dial size={140} value={budget} onChange={setBudget} step={5} label="Daily budget" valueText={`${budget}% used`}><span className="stat-value text-3xl!">{budget}%</span></Dial></GlassPanel>
          </Cell>
          <Cell label={`${t("dev.readOnly")} quota`}>
            <GlassPanel tone="strong"><Dial size={140} value={38} label="Quota left" valueText="38%"><span className="stat-value text-3xl!">38%</span></Dial></GlassPanel>
          </Cell>
          <Cell label={t("dev.loading")}><GlassPanel tone="strong"><Dial size={140} value={0} label="Loading" state="loading" /></GlassPanel></Cell>
          <Cell label={t("dev.error")}><GlassPanel tone="strong"><Dial size={140} value={20} label="Quota" state="error" /></GlassPanel></Cell>
          <Cell label={t("dev.disabled")}><GlassPanel tone="strong"><Dial size={140} value={70} label="Budget" state="disabled" onChange={() => {}} /></GlassPanel></Cell>
        </div>
      </Section>

      <Section id="stat-card" title="StatCard">
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <StatCard
                label="Spend today"
                value="$1.42"
                hint={t("stat.vsLast", { delta: "−12%" })}
                state={s}
                onRetry={() => {}}
                visual={<Dial size={84} value={62} label="Budget used" valueText="62%"><span className="text-sm font-bold">62%</span></Dial>}
              />
            </Cell>
          ))}
        </div>
      </Section>

      <Section id="route-chip" title="RouteChip">
        <div className="flex flex-wrap items-start gap-6">
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}><RouteChip target="Claude Code" rule="refactor-large" state={s} onClick={() => {}} /></Cell>
          ))}
        </div>
      </Section>

      <Section id="provider-card" title="ProviderCard">
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <ProviderCard name="Gemini CLI" kind="cli" status="healthy" free quotaLeft={72} lastError={s === "error" ? "401 from upstream: re-login needed" : undefined} state={s} />
            </Cell>
          ))}
          <Cell label="Warning · paid API"><ProviderCard name="Groq" kind="api" status="warning" quotaLeft={9} trainsOnData /></Cell>
          <Cell label="Offline · local"><ProviderCard name="Ollama" kind="local" status="offline" free /></Cell>
        </div>
      </Section>

      <Section id="job-card" title="JobCard">
        <div className={grid}>
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <JobCard title="Fix failing tests in repo X" agent="Claude Code" status="running" progress={64} elapsed="3m" route={{ target: "claude-code", rule: "code-fix" }} cost={{ kind: "estimate", amount: "$0.18" }} state={s} />
            </Cell>
          ))}
          <Cell label={t("status.needsApproval")}><JobCard title="Push branch fix/tests" agent="Codex" status="needsApproval" cost={{ kind: "free" }} /></Cell>
          <Cell label={t("status.queued")}><JobCard title="Write release notes" agent="Gemini CLI" status="queued" /></Cell>
          <Cell label={t("status.done")}><JobCard title="Summarise PR #12" agent="OpenCode" status="done" cost={{ kind: "paid", amount: "$0.04" }} /></Cell>
        </div>
      </Section>

      <Section id="cost-badge" title="CostBadge">
        <div className="flex flex-wrap items-start gap-6">
          <Cell label="free"><CostBadge kind="free" /></Cell>
          <Cell label="paid"><CostBadge kind="paid" amount="$0.04" /></Cell>
          <Cell label="estimate"><CostBadge kind="estimate" amount="$1.20" /></Cell>
          <Cell label="unknown"><CostBadge kind="unknown" /></Cell>
          <Cell label={t("dev.loading")}><CostBadge kind="paid" state="loading" /></Cell>
          <Cell label={t("dev.error")}><CostBadge kind="paid" state="error" /></Cell>
          <Cell label={t("dev.disabled")}><CostBadge kind="paid" amount="$0.04" state="disabled" /></Cell>
        </div>
      </Section>

      <Section id="status-badge" title="StatusBadge">
        <GlassPanel tone="strong" className="flex flex-wrap gap-6">
          {(["healthy", "warning", "error", "offline", "queued", "running", "needsApproval", "done", "failed"] as const).map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
        </GlassPanel>
      </Section>

      <Section id="explain-popover" title="ExplainPopover">
        <div className="flex flex-wrap items-center gap-6">
          <Cell label={t("dev.default")}>
            <GlassPanel tone="strong" className="flex items-center gap-1 py-2">
              <span className="font-semibold">Fallbacks</span>
              <ExplainPopover topic="Fallbacks" title="What are fallbacks?" learnMoreHref="#fallbacks">
                If the first model is rate-limited, Switchboard tries the next one in the chain. You see which one answered.
              </ExplainPopover>
            </GlassPanel>
          </Cell>
          <Cell label={t("dev.disabled")}>
            <GlassPanel tone="strong" className="flex items-center gap-1 py-2">
              <span className="font-semibold">Fallbacks</span>
              <ExplainPopover topic="Fallbacks" disabled>unused</ExplainPopover>
            </GlassPanel>
          </Cell>
        </div>
      </Section>

      <Section id="composer" title="Composer">
        <div className="grid gap-(--gap) xl:grid-cols-2">
          {allStates.map((s) => (
            <Cell key={s} label={stateLabel(s)}>
              <Composer state={s} defaultValue={s === "empty" ? "" : "Add dark-mode tests to the settings page"} disabledReason={t("home.readOnlyNote")} />
            </Cell>
          ))}
        </div>
      </Section>

      <Section id="toast" title="Toast">
        <div className={grid}>
          <Cell label="info"><ToastView tone="info" title={t("dev.toastTitle")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label="success"><ToastView tone="success" title={t("dev.toastTitle")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label="warning"><ToastView tone="warning" title={t("toast.warning")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
          <Cell label="error"><ToastView tone="error" title={t("state.error")} body={t("dev.toastBody")} onClose={() => {}} /></Cell>
        </div>
        <div>
          <Button variant="glass" onClick={() => push({ tone: "success", title: t("dev.toastTitle"), body: t("dev.toastBody") })}>
            {t("dev.pushToast")}
          </Button>
        </div>
      </Section>

      <Section id="skeleton" title="Skeleton">
        <GlassPanel tone="strong" className="grid max-w-md gap-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4" />
          <Skeleton className="h-4 w-4/5" />
        </GlassPanel>
      </Section>

      <Section id="empty-state" title="EmptyState">
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
