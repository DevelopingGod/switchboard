"use client";

import * as React from "react";
import { FlaskConical, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { dryRun } from "@/app/settings/rules/actions";
import type { DryRunResult, Overrides } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tRules, type RulesKey } from "@/i18n/rules";
import { Check, Field, TextArea } from "./fields";

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Result({ r, pro }: { r: DryRunResult; pro: boolean }) {
  const cls = r.classifier;
  const source = cls ? (tRules(`test.classifierSource.${cls.source}` as RulesKey) || cls.source) : null;
  return (
    <div className="grid gap-4" aria-live="polite">
      <section aria-labelledby="dr-decision" className="grid gap-2">
        <h3 id="dr-decision" className="text-sm font-semibold">
          {tRules("test.decision")}
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-muted">{tRules("test.rule")}</dt>
          <dd className="font-semibold">{r.rule}</dd>
          <dt className="text-ink-muted">{tRules("test.matchedBy")}</dt>
          <dd>{r.matched_by}</dd>
          <dt className="text-ink-muted">{tRules("test.kind")}</dt>
          <dd>
            {r.intent}
            {r.intent === "code" ? `, ${r.size}` : ""}
          </dd>
          {cls && (
            <>
              <dt className="text-ink-muted">{tRules("test.classifier")}</dt>
              <dd>
                {source}
                {cls.route ? ` · ${tRules("test.classifierRoute", { route: cls.route })}` : ""} · {tRules("test.classifierMs", { ms: cls.ms })}
                {cls.fallback_reason && <span className="block text-ink-muted">{tRules("test.fallbackReason", { reason: cls.fallback_reason })}</span>}
              </dd>
            </>
          )}
          <dt className="text-ink-muted">{tRules("test.chosen")}</dt>
          <dd className="font-semibold">{r.chosen ? r.chosen.label : tRules("test.none")}</dd>
          <dt className="text-ink-muted">{tRules("test.runnerUp")}</dt>
          <dd>{r.runner_up ?? "—"}</dd>
        </dl>
        {r.sensitive && (
          <p className="flex items-center gap-1.5 text-sm">
            <Lock aria-hidden className="size-4 text-accent-strong" /> {tRules("test.sensitive", { category: r.sensitive.category ?? "sensitive" })}
          </p>
        )}
      </section>

      {r.candidates.length > 0 && (
        <section aria-labelledby="dr-cands" className="grid gap-1.5">
          <h3 id="dr-cands" className="text-sm font-semibold">
            {tRules("test.candidates")}
          </h3>
          <ol className="grid gap-1 text-sm">
            {r.candidates.map((c, i) => (
              <li key={c.target} className="flex items-center gap-2 rounded-control bg-glass px-3 py-1.5">
                <span aria-hidden className="tabular-nums text-ink-muted">{i + 1}</span>
                <span className="font-semibold">{c.label}</span>
                {c.note && <span className="text-ink-muted">· {c.note}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {r.reasons.length > 0 && (
        <section aria-labelledby="dr-why" className="grid gap-1.5">
          <h3 id="dr-why" className="text-sm font-semibold">
            {tRules("test.reasons")}
          </h3>
          <ul className="list-disc pl-5 text-sm">
            {r.reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      )}

      {r.scores.length > 0 && (
        <section aria-labelledby="dr-scores" className="grid gap-2">
          <h3 id="dr-scores" className="text-sm font-semibold">
            {tRules("test.scores")}
          </h3>
          <ul className="grid gap-2">
            {r.scores.map((s) => (
              <li key={s.label} className="grid gap-1.5 rounded-control bg-glass p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{tRules("test.scoreOf", { label: s.label, score: s.score.toFixed(2) })}</span>
                  <span className="text-[0.75rem] text-ink-muted">{s.proven ? tRules("test.scoreProven") : tRules("test.scoreNew")}</span>
                </div>
                {pro && (
                  <ul className="grid gap-1">
                    {Object.entries(s.parts).map(([k, v]) => (
                      <li key={k} className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-2 text-[0.8125rem]">
                        <span className="text-ink-muted">{tRules(`test.factors.${k}` as RulesKey) || k}</span>
                        <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-accent-soft">
                          <span className="block h-full rounded-full bg-accent-strong" style={{ width: pct(Math.min(1, Math.max(0, v))) }} />
                        </span>
                        <span className="text-right tabular-nums">{pct(v)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.skipped.length > 0 && (
        <section aria-labelledby="dr-skipped" className="grid gap-1.5">
          <h3 id="dr-skipped" className="text-sm font-semibold">
            {tRules("test.skipped")}
          </h3>
          <ul className="grid gap-1 text-sm text-ink-muted">
            {r.skipped.map((s) => (
              <li key={s.target}>
                <span className="font-semibold text-ink">{s.label}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The dry-run tester: where would this message go? Includes unsaved changes. Nothing is sent. */
export default function DryRunPanel({ draft, dirty, pro, blocked }: { draft: Overrides; dirty: boolean; pro: boolean; blocked: boolean }) {
  const [text, setText] = React.useState("");
  const [priv, setPriv] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ r: DryRunResult; draft: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await dryRun(text, priv, dirty ? draft : null);
    setBusy(false);
    if (r.ok) setResult({ r: r.data, draft: dirty });
    else {
      setResult(null);
      setError(r.error);
    }
  };

  return (
    <GlassPanel as="section" tone="strong" aria-labelledby="dr-h" className={cn("grid content-start gap-4")}>
      <header className="grid gap-1">
        <h2 id="dr-h" className="flex items-center gap-2 font-display text-xl font-bold tracking-tight">
          <FlaskConical aria-hidden className="size-5 text-accent-strong" /> {tRules("test.heading")}
        </h2>
        <p className="text-sm text-ink-muted">{tRules("test.help")}</p>
      </header>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !busy) void run();
        }}
      >
        <Field id="dr-text" label={tRules("test.label")}>
          {(a) => <TextArea {...a} value={text} maxLength={4000} placeholder={tRules("test.placeholder")} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Check id="dr-private" checked={priv} onChange={setPriv}>
          {tRules("test.private")}
        </Check>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !text.trim() || blocked}>
            {busy ? tRules("test.running") : tRules("test.run")}
          </Button>
          <span className="text-[0.8125rem] text-ink-muted">{blocked ? tRules("bar.invalid") : dirty ? tRules("test.usingDraft") : tRules("test.usingSaved")}</span>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm font-semibold text-err">
          {error}
        </p>
      )}
      {result && (
        <>
          <p className="text-[0.8125rem] text-ink-muted">{result.draft ? tRules("test.usingDraft") : tRules("test.usingSaved")}</p>
          <Result r={result.r} pro={pro} />
        </>
      )}
    </GlassPanel>
  );
}
