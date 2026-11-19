import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ready } from "./helpers";

/** The one project version (repo-root VERSION); fixtures.ts must carry the same value. */
const PROJECT_VERSION = readFileSync(join(process.cwd(), "../../VERSION"), "utf8").trim();

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
  test("quota, value saved, version and links (health and spend live in the sidebar)", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const footer = page.getByRole("contentinfo", { name: "Status and links" });
    await expect(footer.getByText("Value saved $0.08")).toBeVisible();
    await expect(footer.getByText("Quota OK")).toBeVisible();
    await expect(footer.getByText(`v${PROJECT_VERSION}`)).toBeVisible();
    await expect(footer.getByRole("link", { name: "GitHub" })).toHaveAttribute("rel", /noopener/);
    // not repeated here: the sidebar owns them
    await expect(footer.getByText(/^Today \$/)).toHaveCount(0);
    await expect(footer.getByRole("list", { name: "Service health" })).toHaveCount(0);

    // Fixture: Paperclip is down, so the sidebar's health dot says something needs attention.
    const dot = page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: /Something needs attention/ });
    await expect(dot).toBeVisible();
    await dot.click();
    await expect(page).toHaveURL(/\/status$/);
  });

  test("collapses to an icon row on phones", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await ready(page);
    const footer = page.getByRole("contentinfo", { name: "Status and links" });
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
    await expect(sheet.getByText("Show or hide the sidebar")).toBeVisible();
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

  for (const path of ["/", "/chat?t=6f1c2a10-0000-4000-8000-000000000001"]) {
    test(`CLS < 0.05 on a throttled phone: ${path.slice(0, 6)}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 412, height: 823 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto("http://127.0.0.1:3210" + path + (path.includes("?") ? "&" : "?") + "nosplash");
      await page.waitForLoadState("networkidle");
      expect(await cls(page)).toBeLessThan(0.05);
      await ctx.close();
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

test.describe("ambient cursor and motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("glow follows a fine pointer; the native cursor and the text I-beam are untouched", async ({ page }) => {
    await page.goto("/chat?nosplash");
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-cursor-live"));
    await page.mouse.move(400, 400);
    await page.mouse.move(600, 500, { steps: 8 });
    await expect(page.locator(".sb-glow")).toHaveAttribute("data-on", "");
    expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe("auto");
    expect(await page.locator("textarea[data-composer]").evaluate((el) => getComputedStyle(el).cursor)).toBe("text");
    expect(await page.evaluate(() => [...document.querySelectorAll("*")].some((el) => getComputedStyle(el).cursor === "none"))).toBe(false);
  });

  test("Settings switch, reduced motion and touch all turn it off", async ({ page, browser }) => {
    await page.goto("/chat?nosplash");
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-cursor-live"));
    await page.evaluate(() => (document.documentElement.dataset.cursor = "off"));
    await expect(page.locator(".sb-glow")).toHaveCount(0);
    await page.evaluate(() => (document.documentElement.dataset.cursor = "on"));
    await expect(page.locator(".sb-glow")).toHaveCount(1);
    await page.evaluate(() => (document.documentElement.dataset.motion = "reduce"));
    await expect(page.locator(".sb-glow")).toHaveCount(0);

    for (const opts of [{ reducedMotion: "reduce" as const }, { hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } }]) {
      const ctx = await browser.newContext(opts);
      const p = await ctx.newPage();
      await p.goto("http://127.0.0.1:3210/chat?nosplash");
      await p.waitForFunction(() => !!document.getElementById("sb-tip"));
      await expect(p.locator(".sb-glow")).toHaveCount(0);
      await ctx.close();
    }
  });

  test("no long tasks (> 50 ms) while the pointer moves over cards and hover effects run", async ({ page }) => {
    await page.goto("/connections?nosplash");
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-cursor-live"));
    await ready(page); // the sidebar's recents finish loading first: this test is about pointer movement, not page load
    await page.evaluate(() => {
      (window as unknown as { __lt: number[] }).__lt = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window as unknown as { __lt: number[] }).__lt.push(e.duration))).observe({ type: "longtask" });
    });
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(40, 200 + i * 60);
      await page.mouse.move(1240, 260 + i * 60, { steps: 40 });
    }
    await page.waitForTimeout(300);
    const long = await page.evaluate(() => (window as unknown as { __lt: number[] }).__lt);
    expect(long.filter((d) => d > 50)).toEqual([]);
  });

  test("everything animated stops under Settings → Motion: Reduce", async ({ page }) => {
    await page.goto("/settings?nosplash&motion=reduce");
    await ready(page);
    const anim = await page.locator(".stagger > *").first().evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toBe("none");
  });
});
