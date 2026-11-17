import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Hand,
  Loader,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t, type StringKey } from "@/i18n/strings";

export type Status =
  | "healthy"
  | "warning"
  | "error"
  | "offline"
  | "queued"
  | "running"
  | "needsApproval"
  | "done"
  | "failed";

interface Spec {
  icon: LucideIcon;
  color: string;
  breathing?: boolean;
}

const specs: Record<Status, Spec> = {
  healthy: { icon: CheckCircle2, color: "text-ok", breathing: true },
  warning: { icon: AlertTriangle, color: "text-warn" },
  error: { icon: XCircle, color: "text-err" },
  offline: { icon: CircleSlash, color: "text-ink-muted" },
  queued: { icon: Clock, color: "text-ink-muted" },
  running: { icon: Loader, color: "text-accent-strong", breathing: true },
  needsApproval: { icon: Hand, color: "text-warn" },
  done: { icon: CheckCircle2, color: "text-ok" },
  failed: { icon: XCircle, color: "text-err" },
};

/** Status is always icon + text + color, never color alone. Live states get a breathing dot. */
export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  const { icon: Icon, color, breathing } = specs[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold", color, className)}>
      {breathing ? (
        <span aria-hidden className="relative grid size-4 place-items-center">
          <span className="breathe absolute size-2.5 rounded-full bg-current opacity-30" />
          <span className="size-1.5 rounded-full bg-current" />
        </span>
      ) : (
        <Icon aria-hidden className="size-4" strokeWidth={2.25} />
      )}
      <span>{t(`status.${status}` as StringKey)}</span>
    </span>
  );
}
