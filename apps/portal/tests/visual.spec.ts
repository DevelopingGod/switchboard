import { test, expect } from "@playwright/test";
import { ready, unstick } from "./helpers";

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

    test("app shell · command palette", async ({ page }) => {
      await page.goto("/");
      await ready(page);
      await page.keyboard.press("Control+k");
      await page.getByRole("dialog").waitFor();
      await expect(page).toHaveScreenshot(`shell-palette-${scheme}.png`);
    });
  });
}
