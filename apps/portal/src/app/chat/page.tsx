import type { Metadata } from "next";
import { MessageSquare } from "lucide-react";
import { ScreenStub } from "@/components/shell/ScreenStub";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("screens.chat.title") };

export default function Page() {
  return <ScreenStub titleKey="screens.chat.title" bodyKey="screens.chat.body" icon={<MessageSquare aria-hidden className="size-6" />} />;
}
