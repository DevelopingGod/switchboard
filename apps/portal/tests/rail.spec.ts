import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, settled } from "./helpers";

/**
 * The collapsed rail on a short window: no visible scrollbar, scrolling by wheel, touch and keyboard,
 * a fade only while there is more below, and Settings and profile reachable.
 */
const rail = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const scroller = (page: Page) => page.locator("#app-sidebar .sb-inner");
const top = (page: Page) => scroller(page).evaluate((el) => el.scrollTop);
const fade = (page: Page) => page.locator("#app-sidebar").evaluate((el) => Number(getComputedStyle(el, "::after").opacity || 0));

async function open(page: Page) {
  await page.goto("/jobs");
  await ready(page);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await settled(page);
}

/** On screen, inside the rail, and not painted under another element. */
async function reachable(page: Page, name: string | RegExp) {
  const link = rail(page).getByRole("link", { name, exact: typeof name === "string" });
  await expect(link).toBeInViewport({ ratio: 1 });
  await link.click({ trial: true });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`collapsed rail at 1280×600 · ${scheme}`, () => {
    test.use({ viewport: { width: 1280, height: 600 }, colorScheme: scheme });

    test("no scrollbar; the fade shows only while there is more below", async ({ page }) => {
      await open(page);
      const box = await scroller(page).evaluate((el) => ({
        over: el.scrollHeight > el.clientHeight,
        bar: getComputedStyle(el).scrollbarWidth,
        gutter: (el as HTMLElement).offsetWidth - el.clientWidth - 2 * parseFloat(getComputedStyle(el).borderLeftWidth),
      }));
      expect(box.over).toBe(true);
      expect(box.bar).toBe("none");
      expect(box.gutter).toBeLessThanOrEqual(0);
      await expect.poll(() => fade(page)).toBe(1);
      await expect(rail(page)).toHaveScreenshot(`rail-short-${scheme}.png`);
      await scroller(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await expect.poll(() => fade(page)).toBe(0);
      await reachable(page, "Settings");
      await reachable(page, /profile/i);
      expect((await new AxeBuilder({ page }).include("#app-sidebar").analyze()).violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    });

    test("wheel scrolls it", async ({ page }) => {
      await open(page);
      await scroller(page).hover({ position: { x: 20, y: 300 } });
      await page.mouse.wheel(0, 2000);
      await expect.poll(() => fade(page)).toBe(0);
      expect(await top(page)).toBeGreaterThan(0);
      await reachable(page, "Settings");
      await page.mouse.wheel(0, -2000);
      await expect.poll(() => top(page)).toBe(0);
      await expect.poll(() => fade(page)).toBe(1);
    });

    test("keyboard reaches Settings and profile", async ({ page }) => {
      await open(page);
      await rail(page).getByRole("link", { name: "Chat", exact: true }).focus();
      await page.keyboard.press("End");
      await expect.poll(() => top(page)).toBeGreaterThan(0);
      await page.keyboard.press("Home");
      await expect.poll(() => top(page)).toBe(0);
      for (const name of ["Settings", /profile/i]) {
        const link = rail(page).getByRole("link", { name, exact: typeof name === "string" });
        for (let i = 0; i < 25 && !(await link.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
        await reachable(page, name);
      }
    });
  });
}

test.describe("collapsed rail · touch", () => {
  test.use({ viewport: { width: 1280, height: 600 }, hasTouch: true });

  test("a swipe scrolls it", async ({ page }) => {
    await open(page);
    const cdp = await page.context().newCDPSession(page);
    const box = (await scroller(page).boundingBox())!;
    // A finger drag upwards, as real touch events (the browser turns them into a scroll). It starts near
    // the bottom, on the budget dial: a read-only dial must not swallow the swipe.
    const x = Math.round(box.x + box.width / 2);
    const from = Math.round(box.y + box.height - 60);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", y?: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: y === undefined ? [] : [{ x, y }] });
    await touch("touchStart", from);
    for (let step = 1; step <= 20; step++) {
      await touch("touchMove", from - step * 20);
      await page.waitForTimeout(16); // one frame per move, or no scroll gesture is recognised
    }
    await touch("touchEnd");
    await expect.poll(() => top(page)).toBeGreaterThan(0);
    await expect.poll(() => fade(page)).toBe(0);
    await reachable(page, "Settings");
  });
});

test.describe("collapsed rail · motion", () => {
  test("the fade has no transition under reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await open(page);
    const seconds = await page.locator("#app-sidebar").evaluate((el) => parseFloat(getComputedStyle(el, "::after").transitionDuration));
    expect(seconds).toBeLessThanOrEqual(0.001);
  });

  test("a tall window has nothing below and shows no fade", async ({ page }) => {
    await open(page);
    expect(await fade(page)).toBe(0);
  });
});
