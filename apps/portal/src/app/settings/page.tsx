import type { Metadata } from "next";
import { Settings } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.settings.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.settings.title" bodyKey="screens.settings.body" icon={<Settings aria-hidden className="size-6" />} />;
}
