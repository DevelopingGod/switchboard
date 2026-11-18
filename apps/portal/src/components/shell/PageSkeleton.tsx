import { Skeleton, LoadingLabel } from "@/components/kit/Skeleton";
import { cn } from "@/lib/cn";

/**
 * Route-loading skeletons (M1.5, app/<route>/loading.tsx). Each mirrors its page's real layout
 * (heading, then the main blocks at their final sizes), so swapping in the page does not shift it.
 */
export function PageSkeleton({ variant }: { variant: "chat" | "cards" | "settings" | "list" | "wizard" }) {
  return (
    <div className="grid gap-8" aria-busy="true">
      <LoadingLabel />
      {variant !== "chat" && (
        <div className="grid gap-3">
          <Skeleton className="h-12 w-72 rounded-control sm:h-14" />
          <Skeleton className="h-5 w-[min(36rem,90%)] rounded-chip" />
        </div>
      )}
      {variant === "chat" && (
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="surface-strong hidden h-[70vh] rounded-panel p-4 lg:grid lg:content-start lg:gap-3">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} className="h-9 rounded-control" />
            ))}
          </div>
          <div className="mx-auto grid w-full max-w-[760px] content-start gap-4">
            <Skeleton className="ml-auto h-12 w-2/3 rounded-panel" />
            <Skeleton className="h-40 rounded-panel" />
            <Skeleton className="ml-auto h-12 w-1/2 rounded-panel" />
            <Skeleton className="h-28 rounded-panel" />
          </div>
        </div>
      )}
      {variant === "cards" && (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-72 rounded-panel" />
          ))}
        </div>
      )}
      {(variant === "settings" || variant === "list") && (
        <div className={cn("grid gap-6", variant === "settings" && "lg:grid-cols-[14rem_minmax(0,1fr)]")}>
          {variant === "settings" && <Skeleton className="hidden h-64 rounded-panel lg:block" />}
          <div className="grid gap-4">
            {Array.from({ length: variant === "list" ? 7 : 3 }, (_, i) => (
              <Skeleton key={i} className={cn("rounded-panel", variant === "list" ? "h-16" : "h-48")} />
            ))}
          </div>
        </div>
      )}
      {variant === "wizard" && <Skeleton className="mx-auto h-[28rem] w-full max-w-3xl rounded-hero" />}
    </div>
  );
}
