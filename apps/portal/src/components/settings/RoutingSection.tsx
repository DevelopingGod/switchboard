"use client";

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/kit/Toast";
import { saveSettings } from "@/app/settings/actions";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

/** M3a: the recommender's explore switch. */
export default function RoutingSection({ explore }: { explore: boolean }) {
  const { push } = useToast();
  const [on, setOn] = React.useState(explore);
  const [busy, setBusy] = React.useState(false);
  return (
    <Section id="routing" title={tSet("section.routing")} explain={tSet("routing.explain")}>
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <span id="explore-label" className="text-sm font-semibold">
            {tSet("routing.explore")}
          </span>
          <span id="explore-help" className="text-[0.8125rem] text-ink-muted">
            {tSet("routing.exploreHint")}
          </span>
        </div>
        <Switch
          checked={on}
          disabled={busy}
          aria-labelledby="explore-label"
          aria-describedby="explore-help"
          onCheckedChange={async (next) => {
            setOn(next);
            setBusy(true);
            const r = await saveSettings({ explore: next });
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
