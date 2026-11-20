"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { ErrorNote } from "@/components/kit/ErrorNote";
import type { LocalProfileView, Preset, SettingsView } from "@/lib/router-types";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

// Each section is its own chunk (rendered on the server, so nothing shifts while they load).
const ProfileSection = dynamic(() => import("./ProfileSection"));
const GoalsSection = dynamic(() => import("./GoalsSection"));
const AppearanceSection = dynamic(() => import("./AppearanceSection"));
const PrivacySection = dynamic(() => import("./PrivacySection"));
const BudgetsSection = dynamic(() => import("./BudgetsSection"));
const JobsSection = dynamic(() => import("./JobsSection"));
const RoutingSection = dynamic(() => import("./RoutingSection"));
const LocalModelsSection = dynamic(() => import("./LocalModelsSection"));
const DataSection = dynamic(() => import("./DataSection"));

const SECTIONS = ["profile", "goals", "appearance", "privacy", "routing", "local", "budgets", "jobs", "data", "setup"] as const;

export interface SettingsData {
  name: string;
  goals: string[];
  preset: Preset;
  available: string[];
  settings: SettingsView | null;
  spentToday: number | null;
  /** M3a: null when the router or Ollama can't be asked. */
  localProfile: LocalProfileView | null;
  /** Router unreachable: router-backed sections show a plain error instead. */
  routerCode: string | null;
}

export function SettingsScreen({ data }: { data: SettingsData }) {
  const down = <ErrorNote code={data.routerCode ?? "router_down"} actions={{}} />;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label={tSet("nav")} className="surface-strong hidden rounded-panel p-2 lg:sticky lg:top-24 lg:block">
        <ul className="grid gap-0.5">
          {SECTIONS.map((s) => (
            <li key={s}>
              <a href={`#${s}`} className="flex min-h-9 items-center rounded-control px-3 text-sm font-semibold text-ink-muted hover:bg-pill-active hover:text-ink">
                {tSet(`section.${s}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="stagger grid min-w-0 gap-5">
        <div>
          <ProfileSection name={data.name} />
        </div>
        <div>
          {data.routerCode ? (
            <Section id="goals" title={tSet("section.goals")}>{down}</Section>
          ) : (
            <GoalsSection available={data.available} goals={data.goals} preset={data.preset} />
          )}
        </div>
        <div>
          <AppearanceSection />
        </div>
        <div>
          {data.settings ? (
            <PrivacySection privateDefault={data.settings.private_by_default} autoPrivate={data.settings.auto_private} />
          ) : (
            <Section id="privacy" title={tSet("section.privacy")}>{down}</Section>
          )}
        </div>
        <div>
          {data.settings ? <RoutingSection explore={data.settings.explore} /> : <Section id="routing" title={tSet("section.routing")}>{down}</Section>}
        </div>
        <div>
          {data.localProfile ? (
            <LocalModelsSection key={`${data.localProfile.active}-${data.localProfile.missing.length}`} view={data.localProfile} />
          ) : (
            <Section id="local" title={tSet("section.local")}>{down}</Section>
          )}
        </div>
        <div>
          {data.settings ? (
            <BudgetsSection settings={data.settings} spentToday={data.spentToday} />
          ) : (
            <Section id="budgets" title={tSet("section.budgets")}>{down}</Section>
          )}
        </div>
        <div>
          {data.settings ? <JobsSection settings={data.settings} /> : <Section id="jobs" title={tSet("section.jobs")}>{down}</Section>}
        </div>
        <div>
          <DataSection />
        </div>
        <div>
          <Section id="setup" title={tSet("section.setup")}>
            <p className="text-sm text-ink-muted">{tSet("setup.lead")}</p>
            <div>
              <Link
                href="/welcome?step=1&again=1"
                className="inline-flex min-h-8 items-center gap-2 rounded-chip bg-accent px-3.5 text-[0.8125rem] font-semibold text-on-accent"
              >
                <RotateCcw aria-hidden className="size-4" /> {tSet("setup.open")}
              </Link>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
