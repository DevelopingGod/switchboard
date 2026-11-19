import type { Page } from "@playwright/test";

/** Waits for web fonts so screenshots and axe see final layout. */
export async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  // The sidebar's recent chats load once the page is idle (their own chunk, then a fetch). Every full-page
  // capture and layout check includes that list, so wait until it has arrived (or said why it hasn't).
  await page.waitForFunction(
    () => {
      const sb = document.querySelector<HTMLElement>("#app-sidebar");
      if (!sb || getComputedStyle(sb).visibility === "hidden" || document.documentElement.dataset.sidebar === "collapsed") return true;
      const sec = sb.querySelector('section[aria-label="Recent chats"]');
      return !!sec && (!!sec.querySelector("a[data-thread-row]") || /No chats|load your chats/.test(sec.textContent ?? ""));
    },
    undefined,
    { timeout: 8000 },
  );
}

/** Waits until the page height stops changing (lazy chunks that arrive late under load). */
export async function settled(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const h = document.documentElement.scrollHeight;
        setTimeout(() => resolve(document.documentElement.scrollHeight === h), 300);
      }),
    undefined,
    { polling: 100, timeout: 10_000 },
  );
}

/** Sticky chrome would overlay tall element screenshots. */
export async function unstick(page: Page) {
  await page.addStyleTag({ content: "header{position:static!important}" });
}

/** Full-page shots: the chat composer is sticky to the viewport bottom and would cover messages. */
export async function unstickComposer(page: Page) {
  await page.addStyleTag({ content: ".chat-composer{position:relative!important}" });
}

/**
 * Gallery sections use `content-visibility:auto` (they are long and off-screen): until one is scrolled
 * to, it is a 708 px placeholder, and rendering it later changes its size and moves every section
 * below it. Whether a capture lands before or after that render is a race that only shows under load
 * (the light `composer` and `provider-card` flake: 709 px vs 1165 px and 973 px tall). Rendering every
 * section up front makes the layout final and deterministic; thresholds are untouched.
 */
export async function renderAllSections(page: Page) {
  await page.addStyleTag({ content: '[data-testid^="cmp-"]{content-visibility:visible!important}' });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Full-page captures of a page with sticky chrome (sidebar, page header, save bar): sticky elements are
 * painted where the *current scroll position* puts them, and clicks below the fold leave that position
 * a few pixels different from run to run. Scrolling back to the top first makes them deterministic.
 */
export async function atTop(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
