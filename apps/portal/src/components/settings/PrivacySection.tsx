"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/kit/Toast";
import { saveSettings } from "@/app/settings/actions";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

function Toggle({
  id,
  field,
  initial,
  label,
  help,
}: {
  id: string;
  field: "private_by_default" | "auto_private";
  initial: boolean;
  label: string;
  help: string;
}) {
  const { push } = useToast();
  const [on, setOn] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <span id={`${id}-label`} className="text-sm font-semibold">
          {label}
        </span>
        <span id={`${id}-help`} className="text-[0.8125rem] text-ink-muted">
          {help}
        </span>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        onCheckedChange={async (next) => {
          setOn(next);
          setBusy(true);
          const r = await saveSettings({ [field]: next });
          setBusy(false);
          if (!r.ok) {
            setOn(!next);
            push({ tone: "error", title: r.error });
          } else push({ tone: "success", title: tSet("saved") });
        }}
      />
    </div>
  );
}

export default function PrivacySection({ privateDefault, autoPrivate }: { privateDefault: boolean; autoPrivate: boolean }) {
  return (
    <Section id="privacy" title={tSet("section.privacy")} explain={tSet("privacy.explain")}>
      <Toggle id="priv" field="private_by_default" initial={privateDefault} label={tSet("privacy.privateDefault")} help={tSet("privacy.privateHint")} />
      <Toggle id="auto-priv" field="auto_private" initial={autoPrivate} label={tSet("privacy.autoDetect")} help={tSet("privacy.autoDetectHint")} />
    </Section>
  );
}
