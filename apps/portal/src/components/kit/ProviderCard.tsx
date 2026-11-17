import { AlertTriangle, Cloud, Cpu, KeyRound, ShieldCheck, TerminalSquare } from "lucide-react";
import { GlassPanel } from "./GlassPanel";
import { Dial } from "./Dial";
import { StatusBadge, type Status } from "./StatusBadge";
import { CostBadge } from "./CostBadge";
import { Skeleton, LoadingLabel } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

export interface ProviderCardProps {
  name: string;
  kind: "cli" | "api" | "local";
  status?: Extract<Status, "healthy" | "warning" | "error" | "offline">;
  free?: boolean;
  trainsOnData?: boolean;
  /** 0–100, omit when the provider exposes no quota. */
  quotaLeft?: number;
  lastError?: string;
  onTest?: () => void;
  onLogin?: () => void;
  state?: "default" | "loading" | "empty" | "error" | "disabled";
  className?: string;
}

const kindMeta = {
  cli: { icon: TerminalSquare, label: "provider.cli" },
  api: { icon: KeyRound, label: "provider.api" },
  local: { icon: Cpu, label: "provider.local" },
} as const;

export function ProviderCard({
  name,
  kind,
  status = "healthy",
  free,
  trainsOnData,
  quotaLeft,
  lastError,
  onTest,
  onLogin,
  state = "default",
  className,
}: ProviderCardProps) {
  const { icon: KindIcon, label } = kindMeta[kind];
  const disabled = state === "disabled";

  if (state === "loading") {
    return (
      <GlassPanel as="article" aria-busy className={cn("grid gap-4", className)}>
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <Skeleton className="h-16 w-full" />
        <LoadingLabel />
      </GlassPanel>
    );
  }
  if (state === "empty") {
    return (
      <GlassPanel as="article" className={className}>
        <EmptyState
          headingAs="h3"
          icon={<Cloud className="size-6" />}
          title={name}
          body={t("provider.quotaUnknown")}
          action={<Button size="sm" onClick={onLogin}>{kind === "cli" ? t("provider.install") : t("provider.login")}</Button>}
        />
      </GlassPanel>
    );
  }

  const err = state === "error" ? (lastError ?? t("state.error")) : lastError;
  return (
    <GlassPanel as="article" aria-disabled={disabled || undefined} className={cn("grid gap-4", disabled && "opacity-55", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-strong">
            <KindIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-display text-lg font-bold tracking-tight">{name}</h3>
            <p className="label">{t(label)}</p>
          </div>
        </div>
        <StatusBadge status={state === "error" ? "error" : status} />
      </header>

      <div className="surface-strong flex items-center gap-4 p-3">
        {quotaLeft !== undefined ? (
          <Dial value={quotaLeft} label={t("provider.quota")} valueText={`${quotaLeft}%`} size={72} state={state === "error" ? "error" : disabled ? "disabled" : "default"}>
            <span className="text-sm font-bold tabular-nums">{quotaLeft}%</span>
          </Dial>
        ) : null}
        <ul className="grid gap-1.5 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            <CostBadge kind={free ? "free" : "paid"} amount={t("provider.paid")} />
          </li>
          <li className="flex items-center gap-1.5 text-ink-muted">
            {trainsOnData ? <AlertTriangle aria-hidden className="size-4 text-warn" /> : <ShieldCheck aria-hidden className="size-4 text-ok" />}
            {trainsOnData ? t("provider.trains") : t("provider.noTrain")}
          </li>
          {quotaLeft === undefined && <li className="text-ink-muted">{t("provider.quotaUnknown")}</li>}
        </ul>
      </div>

      {err && (
        <p role={state === "error" ? "alert" : undefined} className="flex items-start gap-1.5 text-sm text-err">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-semibold">{t("provider.lastError")}: </span>
            {err}
          </span>
        </p>
      )}

      <footer className="flex gap-2">
        <Button size="sm" variant="glass" onClick={onTest} disabled={disabled}>
          {t("provider.test")}
        </Button>
        {kind !== "local" && (
          <Button size="sm" variant="ghost" onClick={onLogin} disabled={disabled}>
            {kind === "cli" ? t("provider.login") : t("provider.install")}
          </Button>
        )}
      </footer>
    </GlassPanel>
  );
}
