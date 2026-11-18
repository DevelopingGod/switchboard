/**
 * Auto-hiding scrollbars (M1.5). Thumbs are transparent at rest (globals.css) and show while the
 * pointer is over a scroll area, while it has keyboard focus, or for 800 ms after it scrolls. This
 * marks the scrolling element with `data-scrolling`: one passive capture listener, no React state.
 */
const IDLE_MS = 800;

export function installScrollActivity(): () => void {
  const timers = new WeakMap<Element, number>();
  const onScroll = (e: Event) => {
    const el = e.target === document ? document.documentElement : (e.target as Element | null);
    if (!el || !(el instanceof Element)) return;
    if (!el.hasAttribute("data-scrolling")) el.setAttribute("data-scrolling", "");
    const prev = timers.get(el);
    if (prev) window.clearTimeout(prev);
    timers.set(
      el,
      window.setTimeout(() => el.removeAttribute("data-scrolling"), IDLE_MS),
    );
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => document.removeEventListener("scroll", onScroll, { capture: true });
}
