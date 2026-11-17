"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n/strings";

export function RouterDown({ error }: { error: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <GlassPanel as="section" tone="strong" aria-labelledby="router-down">
      <EmptyState
        state="error"
        title={t("connections.routerDown")}
        body={`${error} ${t("connections.routerDownHint")}`}
        icon={<PlugZap aria-hidden className="size-6" />}
        action={
          <Button size="sm" loading={pending} onClick={() => start(() => router.refresh())}>
            {t("connections.refresh")}
          </Button>
        }
      />
    </GlassPanel>
  );
}
