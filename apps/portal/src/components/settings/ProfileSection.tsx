"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { saveOnboarding } from "@/app/welcome/actions";
import { setPrefs } from "@/lib/prefs";
import { tSet } from "@/i18n/settings";
import { Field, Section } from "./Section";

export default function ProfileSection({ name: initial }: { name: string }) {
  const { push } = useToast();
  const [name, setName] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();
  return (
    <Section id="profile" title={tSet("section.profile")} explain={tSet("profile.explain")}>
      <form
        className="grid gap-3 sm:max-w-md"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const r = await saveOnboarding({ name: name.trim() });
          setBusy(false);
          if (!r.ok) return setError(r.error);
          setPrefs({ name: name.trim() });
          push({ tone: "success", title: tSet("saved") });
        }}
      >
        <Field label={tSet("profile.name")} help={tSet("profile.nameHelp")} htmlFor={id}>
          <input
            id={id}
            value={name}
            maxLength={60}
            autoComplete="given-name"
            onChange={(e) => setName(e.target.value)}
            className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3"
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-err">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" size="sm" loading={busy}>
            {busy ? tSet("saving") : tSet("save")}
          </Button>
        </div>
      </form>
    </Section>
  );
}
