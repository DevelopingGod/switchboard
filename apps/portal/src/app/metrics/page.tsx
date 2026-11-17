import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.metrics.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.metrics.title" bodyKey="screens.metrics.body" icon={<BarChart3 aria-hidden className="size-6" />} />;
}
