/**
 * Ambient cursor (M1.5). The native cursor is never hidden or replaced (no `cursor` style anywhere
 * here): a soft periwinkle glow follows the pointer behind the content, and the edge of the glass
 * card under the pointer lights up (CSS `.glow-edge::after`, fed by --mx/--my on that card only).
 *
 * Only with a fine, hovering pointer (desktop), never under reduced motion (OS or Settings), and
 * only while Settings → Appearance → Ambient cursor is on (html[data-cursor]). One passive
 * pointermove listener and one requestAnimationFrame per frame; no React renders.
 */
const GLOW = 520; // px, diameter of the glow layer

export function installCursor(): () => void {
  const root = document.documentElement;
  const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let glow: HTMLDivElement | null = null;
  let frame = 0;
  let x = -GLOW;
  let y = -GLOW;
  let card: HTMLElement | null = null;

  const paint = () => {
    frame = 0;
    if (!glow) return;
    glow.style.transform = `translate3d(${x - GLOW / 2}px, ${y - GLOW / 2}px, 0)`;
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${x - r.left}px`);
      card.style.setProperty("--my", `${y - r.top}px`);
    }
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    x = e.clientX;
    y = e.clientY;
    if (glow) glow.dataset.on = "";
    const next = e.target instanceof Element ? (e.target.closest(".glow-edge") as HTMLElement | null) : null;
    if (next !== card) card = next;
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const onLeave = () => glow && delete glow.dataset.on;

  const start = () => {
    if (glow) return;
    glow = document.createElement("div");
    glow.className = "sb-glow";
    glow.setAttribute("aria-hidden", "true");
    document.body.appendChild(glow);
    root.setAttribute("data-cursor-live", "");
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
  };
  const stop = () => {
    if (!glow) return;
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("pointermove", onMove);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    glow.remove();
    glow = null;
    card = null;
    root.removeAttribute("data-cursor-live");
  };
  const allowed = () => fine.matches && !reduced.matches && root.dataset.motion !== "reduce" && root.dataset.cursor !== "off";
  const sync = () => (allowed() ? start() : stop());

  sync();
  const watch = new MutationObserver(sync);
  watch.observe(root, { attributes: true, attributeFilter: ["data-cursor", "data-motion"] });
  fine.addEventListener("change", sync);
  reduced.addEventListener("change", sync);
  return () => {
    watch.disconnect();
    fine.removeEventListener("change", sync);
    reduced.removeEventListener("change", sync);
    stop();
  };
}
