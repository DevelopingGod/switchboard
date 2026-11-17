import { BarChart3, MessageSquare, Palette, PlugZap, SquareKanban } from "lucide-react";
import type { PillTab } from "@/components/kit/PillTabs";
import { t } from "@/i18n/strings";

const icon = "size-4";

export const navItems: PillTab[] = [
  { id: "chat", label: t("nav.chat"), href: "/chat", icon: <MessageSquare aria-hidden className={icon} /> },
  { id: "studio", label: t("nav.studio"), href: "/studio", icon: <Palette aria-hidden className={icon} /> },
  { id: "jobs", label: t("nav.jobs"), href: "/jobs", icon: <SquareKanban aria-hidden className={icon} /> },
  { id: "connections", label: t("nav.connections"), href: "/connections", icon: <PlugZap aria-hidden className={icon} /> },
  { id: "metrics", label: t("nav.metrics"), href: "/metrics", icon: <BarChart3 aria-hidden className={icon} /> },
];

export function activeNavId(pathname: string): string | null {
  const seg = pathname.split("/")[1];
  return [...navItems.map((i) => i.id), "settings"].includes(seg) ? seg : null;
}
