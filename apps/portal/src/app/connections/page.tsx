import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectionsFallback, ConnectionsScreen } from "@/components/connections/ConnectionsScreen";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.connections.title") };

export default function Page() {
  return (
    <div className="mx-auto grid max-w-[80rem] gap-10">
      <header className="grid gap-3">
        <h1 className="display">{t("screens.connections.title")}</h1>
        <p className="max-w-2xl text-lg text-ink-muted">{t("connections.intro")}</p>
      </header>
      <Suspense fallback={<ConnectionsFallback />}>
        <ConnectionsScreen />
      </Suspense>
    </div>
  );
}
