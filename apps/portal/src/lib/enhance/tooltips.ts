/**
 * The one tooltip (M1.5). Components mark a trigger with `data-tip="Short label"` (see
 * components/ui/tooltip.tsx), or a truncating text with `data-tip-truncated` (shows its full text,
 * only when it is actually cut off). This delegated layer, loaded after first paint, is the whole
 * implementation, so routes pay nothing for tooltips. Rules:
 * - opens after 500 ms of hover (300 ms skip window when moving between triggers), closes after 100 ms;
 * - keyboard navigation (Tab / arrows, then :focus-visible) shows it at once; focus that a dialog
 *   or menu moves by itself does not; Esc closes it; one at a time;
 * - collision-aware: above the trigger, flipped below near the top edge, clamped to the viewport;
 * - never on touch (touch pointers and coarse-only devices are ignored);
 * - text only, one short sentence (enforced by review; the label is set by our components).
 */
export const OPEN_DELAY_MS = 500;
export const CLOSE_DELAY_MS = 100;
const SKIP_WINDOW_MS = 300;
const GAP = 8;
const EDGE = 8;

const SELECTOR = "[data-tip],[data-tip-truncated]";

export function tipText(el: HTMLElement): string | null {
  const explicit = el.getAttribute("data-tip");
  if (explicit) return explicit;
  if (el.hasAttribute("data-tip-truncated") && el.scrollWidth > el.clientWidth + 1) return el.textContent?.trim() || null;
  return null;
}

/** Where the tooltip goes: above if it fits, otherwise below; always inside the viewport. */
export function placeTip(
  trigger: { top: number; bottom: number; left: number; width: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number; side: "top" | "bottom" } {
  const above = trigger.top - GAP - tip.height;
  const side = above >= EDGE ? "top" : "bottom";
  let y = side === "top" ? above : trigger.bottom + GAP;
  y = Math.min(Math.max(y, EDGE), Math.max(EDGE, viewport.height - tip.height - EDGE));
  const center = trigger.left + trigger.width / 2 - tip.width / 2;
  const x = Math.min(Math.max(center, EDGE), Math.max(EDGE, viewport.width - tip.width - EDGE));
  return { x: Math.round(x), y: Math.round(y), side };
}

export function installTooltips(): () => void {
  const touchOnly = window.matchMedia("(hover: none) and (pointer: coarse)");
  const tip = document.createElement("div");
  tip.id = "sb-tip";
  tip.className = "sb-tip";
  tip.setAttribute("role", "tooltip");
  tip.dataset.state = "closed";
  tip.hidden = true;
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;
  let openTimer = 0;
  let closeTimer = 0;
  let lastClosedAt = 0;
  let suppressed: HTMLElement | null = null; // Esc: stay closed until the pointer leaves or focus moves
  let navKeyAt = -Infinity; // last Tab/arrow press: only focus the person moved shows a tooltip

  const clearTimers = () => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
  };

  const unlink = (el: HTMLElement) => {
    const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== tip.id);
    if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
    else el.removeAttribute("aria-describedby");
  };

  const hide = () => {
    clearTimers();
    if (!current) return;
    unlink(current);
    current = null;
    lastClosedAt = performance.now();
    tip.dataset.state = "closed";
    closeTimer = window.setTimeout(() => {
      if (!current) tip.hidden = true;
    }, CLOSE_DELAY_MS);
  };

  const show = (el: HTMLElement) => {
    clearTimers();
    const text = tipText(el);
    if (!text || !el.isConnected) return;
    if (current && current !== el) unlink(current);
    current = el;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const { x, y, side } = placeTip(r, box, { width: window.innerWidth, height: window.innerHeight });
    tip.style.transform = `translate(${x}px, ${y}px)`;
    tip.dataset.side = side;
    tip.dataset.state = "open";
    // Describe the trigger only when the tooltip adds something to its accessible name.
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    if (name !== text) {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      if (!ids.includes(tip.id)) el.setAttribute("aria-describedby", [...ids, tip.id].join(" "));
    }
  };

  const schedule = (el: HTMLElement) => {
    clearTimers();
    if (el === current) return;
    const quick = performance.now() - lastClosedAt < SKIP_WINDOW_MS || current !== null;
    openTimer = window.setTimeout(() => show(el), quick ? 0 : OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    window.clearTimeout(openTimer);
    if (!current) return;
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, CLOSE_DELAY_MS);
  };

  const target = (n: EventTarget | null) => (n instanceof Element ? (n.closest(SELECTOR) as HTMLElement | null) : null);

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === "touch" || touchOnly.matches) return;
    const el = target(e.target);
    if (!el) return;
    if (el === suppressed) return;
    if (el === current) window.clearTimeout(closeTimer);
    else schedule(el);
  };
  const onOut = (e: PointerEvent) => {
    const el = target(e.target);
    if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
    if (el === suppressed) suppressed = null;
    if (el === current) scheduleClose();
    else window.clearTimeout(openTimer);
  };
  const onFocusIn = (e: FocusEvent) => {
    const el = target(e.target);
    if (!el || !(e.target as Element).matches(":focus-visible")) return;
    if (performance.now() - navKeyAt > 300) return;
    suppressed = null;
    show(el);
  };
  const onFocusOut = (e: FocusEvent) => {
    if (target(e.target) === current) hide();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab" || e.key.startsWith("Arrow")) navKeyAt = performance.now();
    if (e.key === "Escape" && current) {
      suppressed = current;
      hide();
    }
  };
  const onDismiss = () => {
    if (current || openTimer) hide();
  };

  document.addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("pointerout", onOut, { passive: true });
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDismiss, { passive: true, capture: true });
  window.addEventListener("scroll", onDismiss, { passive: true, capture: true });
  window.addEventListener("resize", onDismiss, { passive: true });
  return () => {
    hide();
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onDismiss, { capture: true });
    window.removeEventListener("scroll", onDismiss, { capture: true });
    window.removeEventListener("resize", onDismiss);
    tip.remove();
  };
}
