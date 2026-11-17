"use client";

import * as React from "react";
import { AlertTriangle, ArrowUp, Lock, Paperclip, Sparkles, Square } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { Dial } from "./Dial";
import { ExplainPopover } from "./ExplainPopover";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePrefs } from "@/lib/prefs";
import { cn } from "@/lib/cn";
import { applySlash, slashMatches, type SlashCommand } from "@/lib/slash";
import { strings, t, type StringKey } from "@/i18n/strings";

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
  /** Replaces the static "Target: Auto" label (Chat passes the lazy target picker). */
  targetSlot?: React.ReactNode;
  /** Optional control of the options (Chat keeps them across messages). */
  privateOn?: boolean;
  onPrivateChange?: (on: boolean) => void;
  autonomy?: number;
  onAutonomyChange?: (level: number) => void;
  temperature?: number;
  onTemperatureChange?: (t: number) => void;
  /** A reply is streaming: Send becomes Stop. */
  streaming?: boolean;
  onStop?: () => void;
  /** Shorter text box (Chat, where the composer is pinned to the bottom of the screen). */
  compact?: boolean;
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
  targetSlot,
  privateOn,
  onPrivateChange,
  autonomy: autonomyProp,
  onAutonomyChange,
  temperature: tempProp,
  onTemperatureChange,
  streaming = false,
  onStop,
  compact = false,
}: ComposerProps) {
  const { mode } = usePrefs();
  const [inner, setInner] = React.useState(defaultValue);
  const text = value ?? inner;
  const setText = (v: string) => {
    setInner(v);
    onValueChange?.(v);
  };
  const [autonomyInner, setAutonomyInner] = React.useState(1);
  const [privInner, setPrivInner] = React.useState(false);
  const [tempInner, setTempInner] = React.useState(0.7);
  const autonomy = autonomyProp ?? autonomyInner;
  const priv = privateOn ?? privInner;
  const temp = tempProp ?? tempInner;
  const setAutonomy = (v: number) => (onAutonomyChange ? onAutonomyChange(v) : setAutonomyInner(v));
  const setPriv = (v: boolean) => (onPrivateChange ? onPrivateChange(v) : setPrivInner(v));
  const setTemp = (v: number) => (onTemperatureChange ? onTemperatureChange(v) : setTempInner(v));

  const ids = React.useId();
  const area = React.useRef<HTMLTextAreaElement>(null);
  const hintList = React.useRef<HTMLUListElement>(null);
  React.useImperativeHandle(inputRef, () => area.current as HTMLTextAreaElement, []);

  const disabled = state === "disabled";
  const busy = state === "loading";
  const locked = disabled || busy;
  const level = strings.autonomy.levels[autonomy];
  const hints = locked ? null : slashMatches(text);

  const send = () => {
    if (!text.trim() || locked || streaming) return;
    onSend?.({ text: text.trim(), autonomy, private: priv, temperature: temp });
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (streaming) onStop?.();
    else send();
  };
  const pick = (cmd: SlashCommand) => {
    const v = applySlash(cmd);
    setText(v);
    const el = area.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(v.length, v.length));
    }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hints && e.key === "ArrowDown") {
      e.preventDefault();
      hintList.current?.querySelector("button")?.focus();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (hints && hints.length === 1 && text !== applySlash(hints[0]).trim()) pick(hints[0]);
      else send();
    }
  };
  const onHintKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const items = [...(hintList.current?.querySelectorAll("button") ?? [])];
    const i = items.indexOf(e.currentTarget);
    if (e.key === "ArrowDown") items[Math.min(i + 1, items.length - 1)]?.focus();
    else if (e.key === "ArrowUp") (i === 0 ? area.current : items[i - 1])?.focus();
    else if (e.key === "Escape") area.current?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <GlassPanel
      as="form"
      blur={2}
      onSubmit={submit}
      aria-busy={busy || undefined}
      className={cn("grid gap-3 rounded-hero p-3 sm:p-4", className)}
    >
      <div className={cn("surface-strong relative rounded-[calc(var(--radius-hero)-10px)]", compact ? "px-4 py-3" : "p-4")}>
        <label htmlFor={`${ids}-msg`} className={cn("label block", compact ? "mb-1" : "mb-2")}>
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
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          readOnly={locked}
          rows={compact ? 2 : 3}
          placeholder={t("composer.placeholder")}
          aria-describedby={`${ids}-note`}
          aria-invalid={state === "error" || undefined}
          className={cn(
            "block w-full resize-none bg-transparent leading-relaxed tracking-tight text-ink placeholder:text-ink-muted focus-visible:outline-none",
            compact ? "min-h-14 text-base" : "min-h-24 text-lg",
            busy && "sr-only",
          )}
        />
        {hints && (
          <ul ref={hintList} aria-label={t("composer.slash.label")} className="mt-2 grid gap-1 border-t border-hairline pt-2">
            {hints.map((cmd) => (
              <li key={cmd}>
                <button
                  type="button"
                  onClick={() => pick(cmd)}
                  onKeyDown={onHintKey}
                  className="flex w-full items-baseline gap-3 rounded-control px-2 py-1.5 text-left text-sm hover:bg-pill-active focus-visible:bg-pill-active"
                >
                  <span className="font-mono font-semibold">/{cmd}</span>
                  <span className="text-ink-muted">{t(`composer.slash.${cmd}` as StringKey)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p id={`${ids}-note`} className={cn("text-sm", !compact && "min-h-5")}>
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

        {targetSlot ?? (
          <span className="inline-flex min-h-9 items-center gap-1.5 rounded-chip border border-hairline bg-glass-strong px-3 text-[0.8125rem] font-semibold">
            <Sparkles aria-hidden className="size-3.5 text-accent-strong" />
            <span className="label">{t("composer.target")}</span> {t("composer.auto")}
          </span>
        )}

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

        {streaming ? (
          <Button type="submit" variant="glass" className="ml-auto">
            <Square aria-hidden className="size-3.5 fill-current" />
            {t("composer.stop")}
          </Button>
        ) : (
          <Button type="submit" className="ml-auto" loading={busy} disabled={disabled || (!busy && !text.trim())}>
            {busy ? t("composer.sending") : t("composer.send")}
            {!busy && <ArrowUp aria-hidden className="size-4" />}
          </Button>
        )}
      </div>
    </GlassPanel>
  );
}
