import * as React from "react";

/**
 * Marks the scroller's parent with `data-more` while there is more content below the fold, so CSS can
 * show a fade there (the collapsed rail hides its scrollbar). Writes the attribute directly: no render.
 */
export function useMoreBelow(ref: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const check = () => host.toggleAttribute("data-more", el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    const sizes = new ResizeObserver(check); // fires once on observe, then when the window or a section resizes
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      sizes.disconnect();
      el.removeEventListener("scroll", check);
      host.removeAttribute("data-more");
    };
  }, [ref]);
}
