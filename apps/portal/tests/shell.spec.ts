import { test, expect } from "@playwright/test";
import { ready } from "./helpers";

test("theme follows the system by default", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto("http://localhost:3210/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await ctx.close();
  }
});

test("⌘K palette navigates and toggles preferences", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: "Jobs" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: /compact density/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
});

test("Simple/Pro switch reveals temperature in the composer", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  await expect(page.getByText("Temperature")).toHaveCount(0);
  await page.getByRole("radio", { name: "Pro" }).click();
  await expect(page.getByText("Temperature")).toBeVisible();
});

test("autonomy dial is keyboard operable", async ({ page }) => {
  await page.goto("/");
  await ready(page);
  const dial = page.getByRole("slider", { name: "Autonomy" });
  await dial.focus();
  await expect(dial).toHaveAttribute("aria-valuenow", "1");
  await page.keyboard.press("ArrowRight");
  await expect(dial).toHaveAttribute("aria-valuenow", "2");
  await page.keyboard.press("End");
  await expect(dial).toHaveAttribute("aria-valuetext", /Full auto/);
});

test("solid surfaces switch removes backdrop blur", async ({ page }) => {
  await page.goto("/dev/components");
  await ready(page);
  const blur = () => page.locator(".glass").first().evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(await blur()).toContain("blur");
  await page.goto("/dev/components?solid=1");
  expect(await blur()).toBe("none");
});

test("prefers-reduced-transparency falls back to solid surfaces", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await page.goto("/dev/components");
  await ready(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  const supported = await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches);
  test.skip(!supported, "this Chromium build does not expose prefers-reduced-transparency");
  await expect
    .poll(() => page.locator(".glass").first().evaluate((el) => getComputedStyle(el).backdropFilter))
    .toBe("none");
});

test("reduced motion stops cloud drift and shimmer", async ({ page }) => {
  await page.goto("/dev/components"); // config sets reducedMotion: reduce
  await ready(page);
  const anim = await page.locator(".sky-cloud").first().evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("none");
});

test("mobile shows bottom nav and a read-only composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("navigation", { name: "Primary (mobile)" })).toBeVisible();
  await expect(page.getByLabel("Message")).toHaveAttribute("readonly", "");
});

test("max two stacked blur layers", async ({ page }) => {
  await page.goto("/dev/components");
  await ready(page);
  const deepest = await page.evaluate(() => {
    let max = 0;
    for (const el of document.querySelectorAll("*")) {
      let depth = 0;
      for (let n: Element | null = el; n; n = n.parentElement) {
        const f = getComputedStyle(n).backdropFilter;
        if (f && f !== "none") depth++;
      }
      max = Math.max(max, depth);
    }
    return max;
  });
  expect(deepest).toBeLessThanOrEqual(2);
});
