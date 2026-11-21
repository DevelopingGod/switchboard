import { test, expect } from "@playwright/test";
import { atTop, inPro, ready, renderAllSections, settled, unstick, unstickComposer } from "./helpers";

// Metrics fixtures are dated 21 Nov 2026; relative times ("today 11:15") need that "now" (M6).
const METRICS_NOW = new Date("2026-11-21T12:00:00Z");

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
        await renderAllSections(page);
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
      await settled(page);
      // The thread scrolls itself to the newest message, and the sticky sidebar is painted wherever that
      // scroll lands (it moved by 8 px with bundle timing): capture from the top, like the other pages.
      await atTop(page);
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

    test("chat · why this? popover (Pro: the full breakdown)", async ({ page }) => {
      await inPro(page);
      await page.goto("/chat?t=6f1c2a10-0000-4000-8000-000000000001");
      await ready(page);
      await page.getByRole("button", { name: /Why this\? Routed to Google AI Studio/ }).click();
      const pop = page.getByRole("dialog", { name: "Why this route?" });
      await expect(pop).toBeVisible();
      await expect(pop).toHaveScreenshot(`chat-why-pro-${scheme}.png`);
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
      const link = page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Settings" });
      await link.hover();
      await expect(page.locator("#sb-tip")).toHaveAttribute("data-state", "open");
      const b = (await link.boundingBox())!;
      await expect(page).toHaveScreenshot(`tooltip-${scheme}.png`, { clip: { x: 0, y: Math.round(b.y) - 70, width: 300, height: 130 } });
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

    // M4b: the jobs screens (fixture data).
    for (const [name, path] of [
      ["jobs-board", "/jobs?status=needs_approval"],
      ["job-plan", "/jobs/30"],
      ["job-diff", "/jobs/28"],
      ["job-done", "/jobs/25"],
      ["agents", "/jobs/agents"],
      ["projects", "/settings/projects"],
      // M6
      ["metrics", "/metrics"],
      ["metrics-today", "/metrics?range=today"],
      ["metrics-empty", "/metrics?fixture=empty"],
    ] as const) {
      test(name, async ({ page }) => {
        if (path.startsWith("/metrics")) await page.clock.setFixedTime(METRICS_NOW);
        await page.goto(path);
        await ready(page);
        await settled(page);
        await expect(page).toHaveScreenshot(`${name}-${scheme}.png`, { fullPage: true });
      });
    }

    test("metrics · Pro", async ({ page }) => {
      await page.clock.setFixedTime(METRICS_NOW);
      await page.goto("/metrics");
      await ready(page);
      await page.getByRole("complementary", { name: "Sidebar" }).getByRole("radio", { name: "Pro" }).click();
      await page.getByRole("region", { name: "Most valuable requests" }).getByRole("table").waitFor();
      await page.getByRole("region", { name: "Budgets" }).getByRole("meter").first().waitFor();
      await page.getByRole("region", { name: "Free quotas" }).getByRole("meter").first().waitFor();
      await settled(page);
      await expect(page).toHaveScreenshot(`metrics-pro-${scheme}.png`, { fullPage: true });
    });

    test("job · run as job preview", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await page.getByRole("button", { name: "New job" }).click();
      const dlg = page.getByRole("dialog", { name: "New job" });
      await dlg.getByRole("textbox", { name: "Task" }).fill("Add a function multiply(a, b) with tests");
      await dlg.getByRole("button", { name: "Review" }).click();
      await expect(dlg.getByRole("heading", { name: "What will happen" })).toBeVisible();
      await expect(dlg).toHaveScreenshot(`job-preview-${scheme}.png`);
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
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await expect(page).toHaveScreenshot(`chat-collapsed-${scheme}.png`);
    });

    // M3b
    test("sidebar · expanded", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await expect(page.getByRole("region", { name: "Recent chats" }).getByRole("link").first()).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveScreenshot(`sidebar-expanded-${scheme}.png`);
    });

    test("sidebar · collapsed rail", async ({ page }) => {
      await page.goto("/jobs");
      await ready(page);
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await page.mouse.move(700, 400);
      await settled(page);
      await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveScreenshot(`sidebar-collapsed-${scheme}.png`);
    });

    test("sidebar · phone drawer", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto("/jobs");
      await ready(page);
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
      await page.waitForTimeout(350);
      await expect(page).toHaveScreenshot(`sidebar-drawer-${scheme}.png`);
    });

    test("rules · simple", async ({ page }) => {
      await page.goto("/settings/rules");
      await ready(page);
      await expect(page.getByRole("region", { name: "Balanced" })).toBeVisible();
      await settled(page);
      await expect(page).toHaveScreenshot(`rules-simple-${scheme}.png`, { fullPage: true });
    });

    // The sky covers the whole page: a tall page captured in full keeps its sky to the very bottom.
    test("sky · full page, css and image", async ({ page }) => {
      for (const sky of ["css", "image"]) {
        await page.goto(`/settings/rules?sky=${sky}`);
        await ready(page);
        await settled(page);
        await atTop(page);
        await expect(page).toHaveScreenshot(`sky-full-${sky}-${scheme}.png`, { fullPage: true });
      }
    });

    test("rules · pro editor and tester", async ({ page }) => {
      await page.goto("/settings/rules");
      await ready(page);
      await page.getByRole("complementary", { name: "Sidebar" }).getByRole("radio", { name: "Pro" }).click();
      await page.getByRole("tab", { name: "Rules" }).click();
      await page.getByRole("button", { name: "Edit writing", exact: true }).click();
      await page.getByLabel("Message to test").fill("Write a short LinkedIn post about my launch");
      await page.getByRole("button", { name: "Test routing" }).click();
      await expect(page.getByRole("region", { name: "Decision" })).toBeVisible();
      await settled(page);
      await atTop(page); // sticky chrome is painted where the scroll position puts it
      await expect(page).toHaveScreenshot(`rules-pro-${scheme}.png`, { fullPage: true });
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
