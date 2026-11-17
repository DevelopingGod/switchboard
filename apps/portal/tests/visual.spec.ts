import { test, expect } from "@playwright/test";
import { ready, unstick, unstickComposer } from "./helpers";

/** Visual-regression baselines: every gallery section in both themes (default system-follow). */
const sections = [
  "brand",
  "glass-panel",
  "pill-tabs",
  "dial",
  "stat-card",
  "route-chip",
  "provider-card",
  "job-card",
  "cost-badge",
  "status-badge",
  "explain-popover",
  "composer",
  "install-progress",
  "toast",
  "skeleton",
  "empty-state",
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`components · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const id of sections) {
      test(id, async ({ page }) => {
        await page.goto("/dev/components");
        await ready(page);
        await unstick(page);
        await expect(page.getByTestId(`cmp-${id}`)).toHaveScreenshot(`${id}-${scheme}.png`);
      });
    }

    test("app shell · home", async ({ page }) => {
      await page.goto("/");
      await ready(page);
      await expect(page).toHaveScreenshot(`shell-home-${scheme}.png`);
    });

    test("connections", async ({ page }) => {
      await page.goto("/connections");
      await ready(page);
      await expect(page).toHaveScreenshot(`connections-${scheme}.png`, { fullPage: true });
    });

    for (const n of [1, 2, 3, 4, 5]) {
      test(`wizard · step ${n}`, async ({ page }) => {
        await page.goto(`/welcome?step=${n}`);
        await ready(page);
        await expect(page).toHaveScreenshot(`wizard-${n}-${scheme}.png`, { fullPage: true });
      });
    }

    test("chat · thread with code, fallback chip and feedback", async ({ page }) => {
      await page.goto("/chat?t=6f1c2a10-0000-4000-8000-000000000001");
      await ready(page);
      await expect(page.locator("pre code.hljs").first()).toBeVisible(); // highlighting chunk loaded
      await unstickComposer(page);
      await expect(page).toHaveScreenshot(`chat-${scheme}.png`, { fullPage: true });
    });

    test("chat · why this? popover", async ({ page }) => {
      await page.goto("/chat?t=6f1c2a10-0000-4000-8000-000000000001");
      await ready(page);
      await page.getByRole("button", { name: /Why this\? Routed to Google AI Studio/ }).click();
      const pop = page.getByRole("dialog", { name: "Why this route?" });
      await expect(pop).toBeVisible();
      await expect(pop).toHaveScreenshot(`chat-why-${scheme}.png`);
    });

    test("app shell · command palette", async ({ page }) => {
      await page.goto("/");
      await ready(page);
      await page.keyboard.press("Control+k");
      await page.getByRole("dialog").waitFor();
      await expect(page).toHaveScreenshot(`shell-palette-${scheme}.png`);
    });
  });
}
