"use client";

import * as React from "react";
import { AlertTriangle, ArrowUp, Lock, Paperclip, Sparkles } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { Dial } from "./Dial";
import { ExplainPopover } from "./ExplainPopover";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { strings, t } from "@/i18n/strings";

export interface ComposerSend {
  text: string;
  autonomy: number;
  private: boolean;
  temperature: number;
}

export interface ComposerProps {
  onSend?: (msg: ComposerSend) => void;
  defaultValue?: string;
  /** Controlled text (quick-start chips fill it). Omit to let the composer manage its own text. */
  value?: string;
  onValueChange?: (text: string) => void;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  /** "empty" shows the teaching hint; "disabled" is read-only and needs `disabledReason`. */
  state?: "default" | "loading" | "empty" | "error" | "disabled";
  disabledReason?: string;
  errorMessage?: string;
  className?: string;
}

/** The one large glass composer. Text sits on a near-opaque inner surface. */
export function Composer({
  onSend,
  defaultValue = "",
  value,
  onValueChange,
  inputRef,
  state = "default",
  disabledReason,
  errorMessage,
  className,
}: ComposerProps) {
  const { mode } = usePrefs();
  const [inner, setInner] = React.useState(defaultValue);
  const text = value ?? inner;
  const setText = (v: string) => {
    setInner(v);
    onValueChange?.(v);
  };
  const [autonomy, setAutonomy] = React.useState(1);
  const [priv, setPriv] = React.useState(false);
  const [temp, setTemp] = React.useState(0.7);
  const ids = React.useId();

  const disabled = state === "disabled";
  const busy = state === "loading";
  const locked = disabled || busy;
  const level = strings.autonomy.levels[autonomy];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || locked) return;
    onSend?.({ text: text.trim(), autonomy, private: priv, temperature: temp });
  };

  return (
    <GlassPanel
      as="form"
      blur={2}
      onSubmit={submit}
      aria-busy={busy || undefined}
      className={cn("grid gap-3 rounded-hero p-3 sm:p-4", className)}
    >
      <div className="surface-strong relative rounded-[calc(var(--radius-hero)-10px)] p-4">
        <label htmlFor={`${ids}-msg`} className="label mb-2 block">
          {t("composer.label")}
        </label>
        {busy ? (
          <div aria-hidden className="grid gap-2 py-1">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-8/12" />
          </div>
        ) : null}
        <textarea
          id={`${ids}-msg`}
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={locked}
          rows={3}
          placeholder={t("composer.placeholder")}
          aria-describedby={`${ids}-note`}
          aria-invalid={state === "error" || undefined}
          className={cn(
            "block min-h-24 w-full resize-none bg-transparent text-lg leading-relaxed tracking-tight text-ink placeholder:text-ink-muted focus-visible:outline-none",
            busy && "sr-only",
          )}
        />
        <p id={`${ids}-note`} className="min-h-5 text-sm">
          {disabled ? (
            <span className="flex items-center gap-1.5 text-ink-muted">
              <Lock aria-hidden className="size-4" /> {disabledReason ?? t("composer.disabledDefault")}
            </span>
          ) : state === "error" ? (
            <span role="alert" className="flex items-center gap-1.5 text-err">
              <AlertTriangle aria-hidden className="size-4" /> {errorMessage ?? t("composer.errorDefault")}
            </span>
          ) : state === "empty" ? (
            <span className="text-ink-muted">{t("composer.emptyHint")}</span>
          ) : busy ? (
            <LoadingLabel />
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-1">
        <Button type="button" variant="glass" size="icon" disabled={locked} aria-label={t("composer.attach")}>
          <Paperclip aria-hidden className="size-4" />
        </Button>

        <span className="inline-flex min-h-9 items-center gap-1.5 rounded-chip border border-hairline bg-glass-strong px-3 text-[0.8125rem] font-semibold">
          <Sparkles aria-hidden className="size-3.5 text-accent-strong" />
          <span className="label">{t("composer.target")}</span> {t("composer.auto")}
        </span>

        <div className="flex items-center gap-2">
          <Dial
            size={56}
            stops={strings.autonomy.levels}
            value={autonomy}
            onChange={setAutonomy}
            state={locked ? "disabled" : "default"}
            label={t("composer.autonomy")}
            valueText={t("autonomy.valueText", { level: autonomy, name: level })}
          />
          <div className="grid leading-tight">
            <span className="label inline-flex items-center gap-1">
              {t("composer.autonomy")}
              <ExplainPopover topic={t("composer.autonomy")} title={level}>
                {strings.autonomy.descriptions[autonomy]}
              </ExplainPopover>
            </span>
            <span className="text-sm font-semibold">{level}</span>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold">
          <Switch checked={priv} onCheckedChange={setPriv} disabled={locked} aria-label={t("composer.private")} />
          {t("composer.private")}
        </label>

        {mode === "pro" && (
          <label className="flex items-center gap-2 text-sm font-semibold">
            <span className="label">{t("composer.temperature")}</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={temp}
              disabled={locked}
              onChange={(e) => setTemp(Number(e.target.value))}
              aria-valuetext={temp.toFixed(1)}
              className="w-28 accent-(--accent-strong)"
            />
            <span className="w-8 tabular-nums">{temp.toFixed(1)}</span>
          </label>
        )}

        <Button type="submit" className="ml-auto" loading={busy} disabled={disabled || (!busy && !text.trim())}>
          {busy ? t("composer.sending") : t("composer.send")}
          {!busy && <ArrowUp aria-hidden className="size-4" />}
        </Button>
      </div>
    </GlassPanel>
  );
}
