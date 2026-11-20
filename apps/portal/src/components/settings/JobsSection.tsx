"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/kit/Toast";
import { saveSettings } from "@/app/settings/actions";
import { setPrefs, usePrefs } from "@/lib/prefs";
import type { SettingsView } from "@/lib/router-types";
import { tSet } from "@/i18n/settings";
import { Field, Section } from "./Section";

/** M4b: approval expiry (router setting), desktop notifications (this browser) and the Projects link. */
export default function JobsSection({ settings }: { settings: SettingsView }) {
  const { push } = useToast();
  const prefs = usePrefs();
  const [hours, setHours] = React.useState(String(settings.approval_expiry_h));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const ids = React.useId();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(hours);
    if (hours.trim() === "" || !Number.isFinite(n) || n < 0 || n > 720) return setError(tSet("jobs.invalid"));
    setBusy(true);
    setError(null);
    const r = await saveSettings({ approval_expiry_h: n });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    push({ tone: "success", title: tSet("saved") });
  };

  // Permission is asked only here, when you turn notifications on (never on page load).
  const toggle = async (next: boolean) => {
    setNote(null);
    if (!next) return setPrefs({ jobNotifications: false });
    if (typeof Notification === "undefined") return setNote(tSet("jobs.notificationsUnsupported"));
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") return setNote(tSet("jobs.notificationsDenied"));
    setPrefs({ jobNotifications: true });
  };

  return (
    <Section id="jobs" title={tSet("section.jobs")} explain={tSet("jobs.explain")}>
      <form onSubmit={save} className="grid gap-2">
        <Field label={tSet("jobs.expiry")} help={tSet("jobs.expiryHelp", { n: settings.defaults.approval_expiry_h })} htmlFor={`${ids}-h`}>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${ids}-h`}
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="min-h-(--ctl) w-28 rounded-control border border-hairline bg-glass-strong px-3 tabular-nums"
            />
            <Button type="submit" size="sm" loading={busy}>
              {tSet("save")}
            </Button>
          </div>
        </Field>
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
      </form>
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <span id={`${ids}-n`} className="text-sm font-semibold">
            {tSet("jobs.notifications")}
          </span>
          <span id={`${ids}-nh`} className="text-[0.8125rem] text-ink-muted">
            {tSet("jobs.notificationsHelp")}
          </span>
          {note && (
            <span role="alert" className="text-[0.8125rem] text-warn">
              {note}
            </span>
          )}
        </div>
        <Switch checked={prefs.jobNotifications} aria-labelledby={`${ids}-n`} aria-describedby={`${ids}-nh`} onCheckedChange={(v) => void toggle(v)} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[0.8125rem] text-ink-muted">{tSet("jobs.projects")}</span>
        <Link href="/settings/projects" className="inline-flex min-h-(--ctl) items-center rounded-chip bg-glass-strong px-4 text-sm font-semibold text-ink hover:bg-pill-active">
          {tSet("jobs.projectsLink")}
        </Link>
      </div>
    </Section>
  );
}
