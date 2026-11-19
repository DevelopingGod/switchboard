"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Cpu, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { pullModels } from "@/app/status/actions";
import { setLocalProfile } from "@/app/settings/actions";
import type { LocalProfileView } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

/** M3a: detected GPU -> profile, the owner's pick, and the profile's missing models. */
export default function LocalModelsSection({ view }: { view: LocalProfileView }) {
  const router = useRouter();
  const { push } = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  // Optimistic: the radio moves at once; the section remounts with the server's answer (keyed on it).
  const [selected, setSelected] = React.useState(view.active);
  const det = view.detected;

  const choose = async (name: string | null) => {
    setSelected(name ?? view.recommended);
    setBusy(name ?? "detected");
    const r = await setLocalProfile(name);
    setBusy(null);
    if (!r.ok) {
      setSelected(view.active);
      push({ tone: "error", title: r.error });
    } else push({ tone: "success", title: tSet("saved") });
    router.refresh();
  };

  return (
    <Section id="local" title={tSet("section.local")} explain={tSet("local.explain")}>
      <p className="flex items-center gap-2 text-sm">
        <Cpu aria-hidden className="size-4 text-accent-strong" />
        <span>
          {det.vram_gb != null
            ? tSet("local.detected", { gpu: [det.gpu, tSet("local.vram", { vram: det.vram_gb })].filter(Boolean).join(", ") })
            : tSet("local.noGpu")}
        </span>
      </p>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-semibold">{tSet("local.profile")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {view.profiles.map((p) => {
            const on = p.name === selected;
            return (
              <label
                key={p.name}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-control border p-3 text-sm",
                  on ? "border-accent bg-accent-soft" : "border-hairline hover:bg-pill-active",
                )}
              >
                <input
                  type="radio"
                  name="local-profile"
                  value={p.name}
                  checked={on}
                  disabled={busy !== null}
                  onChange={() => choose(p.name)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span className="grid gap-0.5">
                  <span className="font-semibold">
                    {p.label}
                    {p.name === view.recommended && <span className="ml-1.5 text-xs font-normal text-ink-muted">({tSet("local.recommended")})</span>}
                  </span>
                  <span className="text-[0.8125rem] text-ink-muted">
                    {tSet("local.models", { models: [p.classifier ? "Arch-Router" : tSet("local.classifierNone"), p.general, p.coder !== p.general ? p.coder : null].filter(Boolean).join(" · ") })}
                  </span>
                  {p.cpu && <span className="text-[0.8125rem] text-ink-muted">{tSet("local.cpuNote")}</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {view.overridden && (
        <div>
          <Button size="sm" variant="ghost" loading={busy === "detected"} onClick={() => choose(null)}>
            {tSet("local.useDetected")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {view.ollama !== "ok" ? (
          <p className="text-ink-muted">{tSet("local.ollamaDown")}</p>
        ) : view.pull.status === "running" ? (
          <p role="status" className="text-ink-muted">
            {tSet("local.pulling", { model: view.pull.model ?? "", pct: view.pull.percent ?? 0 })}
          </p>
        ) : view.missing.length ? (
          <>
            <p className="min-w-0 flex-1">{tSet("local.missing", { models: view.missing.join(", ") })}</p>
            <Button
              size="sm"
              variant="glass"
              loading={busy === "pull"}
              onClick={async () => {
                setBusy("pull");
                const r = await pullModels();
                setBusy(null);
                push(r.ok ? { tone: "success", title: tSet("local.pullStarted") } : { tone: "error", title: r.error });
                router.refresh();
              }}
            >
              <Download aria-hidden className="size-4" /> {tSet("local.pull")}
            </Button>
          </>
        ) : (
          <p className="text-ink-muted">{tSet("local.allPulled")}</p>
        )}
      </div>
    </Section>
  );
}
