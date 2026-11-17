import { AlertTriangle, BadgeCheck, Code2, Maximize2, ShieldCheck, Zap, Cpu, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { t, type StringKey } from "@/i18n/strings";
import type { Badge } from "@/lib/recommend";
import type { Privacy } from "@/lib/router-types";

const badgeMeta = {
  code: { icon: Code2, key: "badge.code", free: false },
  fastest: { icon: Zap, key: "badge.fastest", free: false },
  context: { icon: Maximize2, key: "badge.context", free: false },
  free: { icon: BadgeCheck, key: "badge.free", free: true },
} as const;

/** Icon + text, never colour alone. */
export function BadgeChip({ badge }: { badge: Badge }) {
  const { icon: Icon, key, free } = badgeMeta[badge];
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1 rounded-chip border border-hairline bg-glass-strong px-2 text-xs font-semibold",
        free ? "text-ok" : "text-accent-strong",
      )}
    >
      <Icon aria-hidden className="size-3" strokeWidth={2.25} />
      {t(key as StringKey)}
    </span>
  );
}

const privacyIcon = {
  "may-train": { icon: AlertTriangle, color: "text-warn" },
  "no-training": { icon: ShieldCheck, color: "text-ok" },
  local: { icon: Cpu, color: "text-ok" },
  varies: { icon: Info, color: "text-ink-muted" },
} as const;

export function PrivacyLine({ privacy }: { privacy: Privacy }) {
  const { icon: Icon, color } = privacyIcon[privacy] ?? privacyIcon.varies;
  return (
    <span className="flex items-center gap-1.5 text-ink-muted">
      <Icon aria-hidden className={cn("size-4 shrink-0", color)} />
      {t(`privacy.${privacy}` as StringKey)}
    </span>
  );
}
