import { test, expect, type Page } from "@playwright/test";
import { ready } from "./helpers";

/** The enhancement layer (tooltips, scrollbars, cursor) installs on idle; wait for it. */
async function enhanced(page: Page) {
  await ready(page);
  await page.waitForFunction(() => !!document.getElementById("sb-tip"));
}

/** Total layout shift while the page loads and settles (PerformanceObserver, buffered). */
async function cls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
            if (!e.hadRecentInput) total += e.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve(total), 1500);
      }),
  );
}

test.describe("footer", () => {
  test("health dots, spend, quota, version and links", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const footer = page.getByRole("contentinfo", { name: "Status and links" });
    const health = footer.getByRole("list", { name: "Service health" });
    await expect(health.getByText("Router: running")).toBeAttached();
    await expect(health.getByText("Paperclip: not running")).toBeAttached(); // fixture: Paperclip down
    await expect(footer.getByText("Today $0.01")).toBeVisible();
    await expect(footer.getByText("Value saved $0.08")).toBeVisible();
    await expect(footer.getByText("Quota OK")).toBeVisible();
    await expect(footer.getByText("v0.1.5")).toBeVisible();
    await expect(footer.getByRole("link", { name: "GitHub" })).toHaveAttribute("rel", /noopener/);

    await footer.getByRole("link", { name: /^Open status/ }).click();
    await expect(page).toHaveURL(/\/status$/);
  });

  test("collapses to an icon row on phones", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await ready(page);
    const footer = page.getByRole("contentinfo", { name: "Status and links" });
    await expect(footer.getByText("Router", { exact: true })).toBeHidden();
    await expect(footer.getByRole("link", { name: "Docs" })).toBeHidden();
    await expect(footer.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
    const box = await footer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("keyboard shortcuts", () => {
  test("? opens the sheet, Esc closes it, the footer button opens it too", async ({ page }) => {
    await page.goto("/jobs");
    await enhanced(page);
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    // The dialog moves focus to its close button by itself: that must not pop a tooltip.
    await page.waitForTimeout(200);
    await expect(page.locator("#sb-tip")).not.toHaveAttribute("data-state", "open");
    await expect(sheet.getByText("Search and jump to anything")).toBeVisible();
    await expect(sheet.getByText("Show or hide the thread list")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(sheet).toBeVisible();
  });

  test("? typed in a text field is just text", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const box = page.getByRole("textbox").first();
    await box.click();
    await page.keyboard.type("why?");
    await expect(box).toHaveValue("why?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
  });

  test("mod+B toggles the sidebar preference, / focuses the composer", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "open");
    await page.keyboard.press("Control+b");
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
    await page.keyboard.press("Control+b");
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "open");

    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("/");
    await expect(page.locator("textarea[data-composer]")).toBeFocused();
  });
});

test.describe("tooltip", () => {
  test("opens after the hover delay, closes on Esc and pointer leave", async ({ page }) => {
    await page.goto("/jobs");
    await enhanced(page);
    const tip = page.locator("#sb-tip");
    const settings = page.getByRole("link", { name: "Settings" }).first();
    await settings.hover();
    await page.waitForTimeout(250);
    await expect(tip).not.toHaveAttribute("data-state", "open"); // not before ~500 ms
    await expect(tip).toHaveAttribute("data-state", "open");
    await expect(tip).toHaveText("Settings");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveAttribute("data-state", "closed");

    await page.mouse.move(640, 600);
    await settings.hover();
    await expect(tip).toHaveAttribute("data-state", "open");
    await page.mouse.move(640, 600);
    await expect(tip).toHaveAttribute("data-state", "closed");
  });

  test("keyboard focus shows it; only one at a time; stays in the viewport", async ({ page }) => {
    await page.goto("/jobs");
    await enhanced(page);
    const tip = page.locator("#sb-tip");
    await page.getByRole("link", { name: "Settings" }).first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab"); // :focus-visible via keyboard
    await expect(tip).toHaveAttribute("data-state", "open");
    await expect(page.locator(".sb-tip")).toHaveCount(1);
    const b = await tip.boundingBox();
    expect(b!.y).toBeGreaterThanOrEqual(0); // flipped below the top nav, not cut off
    expect(b!.x + b!.width).toBeLessThanOrEqual(1280);
  });

  test("never on touch", async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:3210/jobs");
    await enhanced(page);
    await page.getByRole("button", { name: "Keyboard shortcuts" }).tap();
    await page.waitForTimeout(700);
    await expect(page.locator("#sb-tip")).not.toHaveAttribute("data-state", "open");
    await ctx.close();
  });
});

test.describe("splash and loading", () => {
  test.use({ reducedMotion: "no-preference" });

  test("splash shows once per session, never blocks clicks, gone by 1.2 s", async ({ page }) => {
    await page.goto("/jobs");
    await expect(page.locator("html")).toHaveAttribute("data-splash", /.*/);
    const splash = page.locator("#sb-splash");
    expect(await splash.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    await page.waitForTimeout(1300);
    await expect(splash).toBeHidden();
    await page.goto("/");
    expect(await page.locator("html").getAttribute("data-splash")).toBeNull(); // not again this session
  });

  test("no splash under reduced motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:3210/jobs");
    expect(await page.locator("html").getAttribute("data-splash")).toBeNull();
    await ctx.close();
  });

  for (const path of ["/", "/chat?t=6f1c2a10-0000-4000-8000-000000000001", "/status", "/connections"]) {
    test(`CLS < 0.05 on ${path}`, async ({ page }) => {
      await page.goto(path + (path.includes("?") ? "&" : "?") + "nosplash");
      await ready(page);
      expect(await cls(page)).toBeLessThan(0.05);
    });
  }

  test("client navigation animates the page in (transform/opacity only)", async ({ page }) => {
    await page.goto("/jobs?nosplash");
    await ready(page);
    await page.getByRole("link", { name: "Metrics" }).first().click();
    await expect(page).toHaveURL(/\/metrics/);
    const anim = await page.locator(".page-enter").evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe("page-in");
  });
});
