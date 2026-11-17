import type { Metadata } from "next";
import { PlugZap } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.connections.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.connections.title" bodyKey="screens.connections.body" icon={<PlugZap aria-hidden className="size-6" />} />;
}
