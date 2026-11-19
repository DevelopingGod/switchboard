import { Activity, BarChart3, MessageSquare, Palette, PlugZap, SquareKanban, type LucideIcon } from "lucide-react";
import type { StringKey } from "@/i18n/strings";

export interface NavItem {
  id: string;
  href: string;
  label: StringKey;
  Icon: LucideIcon;
}

/** The sidebar's navigation, in order (M3b). */
export const navItems: readonly NavItem[] = [
  { id: "chat", href: "/chat", label: "nav.chat", Icon: MessageSquare },
  { id: "studio", href: "/studio", label: "nav.studio", Icon: Palette },
  { id: "jobs", href: "/jobs", label: "nav.jobs", Icon: SquareKanban },
  { id: "connections", href: "/connections", label: "nav.connections", Icon: PlugZap },
  { id: "metrics", href: "/metrics", label: "nav.metrics", Icon: BarChart3 },
  { id: "status", href: "/status", label: "nav.status", Icon: Activity },
];

/** Which nav entry a pathname belongs to (`settings` has its own button in the sidebar footer). */
export function activeNavId(pathname: string): string | null {
  const seg = pathname.split("/")[1];
  return [...navItems.map((i) => i.id), "settings"].includes(seg) ? seg : null;
}
