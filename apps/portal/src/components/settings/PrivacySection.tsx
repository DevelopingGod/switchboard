"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/kit/Toast";
import { saveSettings } from "@/app/settings/actions";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

export default function PrivacySection({ privateDefault }: { privateDefault: boolean }) {
  const { push } = useToast();
  const [on, setOn] = React.useState(privateDefault);
  const [busy, setBusy] = React.useState(false);
  return (
    <Section id="privacy" title={tSet("section.privacy")} explain={tSet("privacy.explain")}>
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <span id="priv-label" className="text-sm font-semibold">
            {tSet("privacy.privateDefault")}
          </span>
          <span id="priv-help" className="text-[0.8125rem] text-ink-muted">
            {tSet("privacy.privateHint")}
          </span>
        </div>
        <Switch
          checked={on}
          disabled={busy}
          aria-labelledby="priv-label"
          aria-describedby="priv-help"
          onCheckedChange={async (next) => {
            setOn(next);
            setBusy(true);
            const r = await saveSettings({ private_by_default: next });
            setBusy(false);
            if (!r.ok) {
              setOn(!next);
              push({ tone: "error", title: r.error });
            } else push({ tone: "success", title: tSet("saved") });
          }}
        />
      </div>
    </Section>
  );
}
