import type { Metadata } from "next";
import { SquareKanban } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.jobs.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.jobs.title" bodyKey="screens.jobs.body" icon={<SquareKanban aria-hidden className="size-6" />} />;
}
