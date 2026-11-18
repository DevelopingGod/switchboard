/**
 * Page enhancements that need no React and can wait until after first paint (M1.5): auto-hiding
 * scrollbars, the delegated tooltip layer and the ambient cursor. AppShell imports this module
 * lazily on idle, so none of it is in any route's first-load JS.
 */
import { installScrollActivity } from "./scroll-activity";
import { installTooltips } from "./tooltips";
import { installCursor } from "./cursor";

export function install(): () => void {
  const off = [installScrollActivity(), installTooltips(), installCursor()];
  return () => off.forEach((f) => f());
}
