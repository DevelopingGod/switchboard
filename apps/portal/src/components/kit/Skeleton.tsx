import { cn } from "@/lib/cn";
import { t } from "@/i18n/strings";

/** Soft shimmer placeholder. Decorative; pair with <LoadingLabel/> inside the busy region. */
export function Skeleton({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("shimmer h-4 w-full", className)} {...rest} />;
}

export function LoadingLabel() {
  return (
    <span role="status" className="sr-only">
      {t("state.loading")}
    </span>
  );
}
