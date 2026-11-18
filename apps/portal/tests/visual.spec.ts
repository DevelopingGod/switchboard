import { test, expect } from "@playwright/test";
import { ready, settled, unstick, unstickComposer } from "./helpers";

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
        await settled(page);
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

    // M1.5
    test("footer", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await expect(page.getByRole("contentinfo", { name: "Status and links" })).toHaveScreenshot(`footer-${scheme}.png`);
    });

    test("footer · phone", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto("/jobs");
      await ready(page);
      await expect(page.getByRole("contentinfo", { name: "Status and links" })).toHaveScreenshot(`footer-phone-${scheme}.png`);
    });

    test("tooltip", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await page.waitForFunction(() => !!document.getElementById("sb-tip"));
      await page.getByRole("link", { name: "Settings" }).first().hover();
      await expect(page.locator("#sb-tip")).toHaveAttribute("data-state", "open");
      await expect(page).toHaveScreenshot(`tooltip-${scheme}.png`, { clip: { x: 1000, y: 0, width: 280, height: 140 } });
    });

    test("shortcuts sheet", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveScreenshot(`shortcuts-${scheme}.png`);
    });

    test("settings", async ({ page }) => {
      await page.goto("/settings");
      await ready(page);
      await expect(page).toHaveScreenshot(`settings-${scheme}.png`, { fullPage: true });
    });

    test("status", async ({ page }) => {
      await page.goto("/status");
      await ready(page);
      await expect(page).toHaveScreenshot(`status-${scheme}.png`, { fullPage: true });
    });

    test("chat · hover actions on an earlier reply", async ({ page }) => {
      await page.goto("/chat?t=6f1c2a10-0000-4000-8000-000000000001");
      await ready(page);
      const reply = page.getByRole("article", { name: "Assistant" }).nth(1);
      await reply.hover();
      await expect(reply).toHaveScreenshot(`chat-hover-actions-${scheme}.png`);
    });

    test("chat · sidebar collapsed", async ({ page }) => {
      await page.goto("/chat?t=6f1c2a10-0000-4000-8000-000000000001");
      await ready(page);
      await page.keyboard.press("Control+b");
      await expect(page.getByRole("button", { name: "Show chat list" })).toBeVisible();
      await expect(page).toHaveScreenshot(`chat-collapsed-${scheme}.png`);
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
