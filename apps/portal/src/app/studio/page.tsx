import type { Metadata } from "next";
import { Palette } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.studio.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.studio.title" bodyKey="screens.studio.body" icon={<Palette aria-hidden className="size-6" />} />;
}
