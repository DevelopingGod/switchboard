import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ready } from "./helpers";

/**
 * M3b: the left sidebar shell (ADR 0003). Layout at every supported width and browser zoom, the icon
 * rail, the phone drawer (focus, Esc, inert page), motion, and axe in each state.
 */
const SEED = "/chat?t=6f1c2a10-0000-4000-8000-000000000001";
const WIDTHS = [360, 768, 1024, 1280, 1440, 1920];
const PAGES = ["/", SEED, "/connections", "/settings", "/status", "/jobs", "/jobs/28", "/jobs/agents", "/settings/projects", "/welcome?step=2", "/welcome?step=3"];
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

/** Browser zoom = fewer CSS pixels at a higher device scale factor. */
const zoomed = (base: number, zoom: number) => ({ viewport: { width: Math.round(base / zoom), height: 900 }, deviceScaleFactor: zoom });

async function noHorizontalScroll(page: Page, label: string) {
  const over = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(over.doc, `${label}: page scrolls sideways`).toBeLessThanOrEqual(0);
  expect(over.body, `${label}: body wider than the window`).toBeLessThanOrEqual(0);
}

/** Every visible control and label inside `root` sits fully inside the viewport and isn't cut off by its own box. */
async function nothingClipped(page: Page, root: string, label: string) {
  const problems = await page.evaluate((sel) => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const rootEl = document.querySelector(sel)!;
    const rb = rootEl.getBoundingClientRect();
    for (const el of rootEl.querySelectorAll<HTMLElement>("a,button,input,[role=meter],h3,kbd,span.sb-label")) {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || b.width === 0 || b.height === 0) continue;
      if (cs.opacity === "0") continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 30);
      if (b.left < -0.5 || b.right > vw + 0.5) out.push(`${name}: outside the window (${Math.round(b.left)}–${Math.round(b.right)} of ${vw})`);
      if (b.left < rb.left - 0.5 || b.right > rb.right + 0.5) out.push(`${name}: outside the sidebar (${Math.round(b.left)}–${Math.round(b.right)}, sidebar ${Math.round(rb.left)}–${Math.round(rb.right)})`);
      // text cut by its own box (a label wider than its container, ignoring the intentional truncation)
      if (el.matches("span.sb-label") && el.scrollWidth > el.clientWidth + 1 && !el.closest("[data-tip-truncated]")) out.push(`${name}: text is cut off`);
    }
    return out;
  }, root);
  expect(problems, `${label}\n${problems.join("\n")}`).toEqual([]);
}

async function openDrawerIfPhone(page: Page, width: number) {
  if (width >= 768) return;
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(sidebar(page)).toBeVisible();
}

for (const width of WIDTHS) {
  test.describe(`layout · ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const path of PAGES) {
      test(`${path}: no sideways scroll, sidebar fully visible`, async ({ page }) => {
        await page.goto(path);
        await ready(page);
        await noHorizontalScroll(page, `${path} @${width}`);
        await openDrawerIfPhone(page, width);
        await nothingClipped(page, ".app-sidebar", `${path} @${width}`);
        await expect(sidebar(page).getByRole("link", { name: "New chat" })).toBeVisible();
        await expect(sidebar(page).getByRole("link", { name: "Settings" })).toBeVisible();
        for (const n of ["Chat", "Studio", "Jobs", "Connections", "Metrics", "Status"]) {
          await expect(sidebar(page).getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: n })).toBeVisible();
        }
      });
    }
  });
}

for (const [base, zoom] of [[1280, 1.25], [1280, 1.5], [1920, 1.25], [1920, 1.5], [1024, 1.25], [768, 1.5]] as const) {
  test.describe(`zoom ${zoom * 100}% of ${base}px`, () => {
    test.use(zoomed(base, zoom));
    for (const path of ["/", SEED, "/connections", "/settings"]) {
      test(`${path}`, async ({ page }) => {
        await page.goto(path);
        await ready(page);
        const css = Math.round(base / zoom);
        await noHorizontalScroll(page, `${path} @${zoom * 100}% (${css} css px)`);
        await openDrawerIfPhone(page, css);
        await nothingClipped(page, ".app-sidebar", `${path} @${zoom * 100}% (${css} css px)`);
      });
    }
  });
}

test.describe("collapse to the icon rail", () => {
  test("rail width, labels gone, tooltips stand in, state survives a reload", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const full = (await sidebar(page).boundingBox())!.width;
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await expect.poll(async () => (await sidebar(page).boundingBox())!.width).toBeLessThan(full - 120);
    await expect(sidebar(page).getByText("Connections", { exact: true })).toBeHidden();
    await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeHidden();
    await nothingClipped(page, ".app-sidebar", "collapsed");
    await noHorizontalScroll(page, "collapsed");

    // every rail control keeps an accessible name, and its tooltip says it
    const nav = sidebar(page).getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Connections" })).toBeVisible();
    await page.waitForFunction(() => !!document.getElementById("sb-tip"));
    await nav.getByRole("link", { name: "Connections" }).hover();
    await expect(page.locator("#sb-tip")).toHaveText("Connections");

    await page.reload();
    await ready(page);
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect.poll(async () => (await sidebar(page).boundingBox())!.width).toBeGreaterThan(full - 4);
  });

  test("the collapse animates, and reduced motion turns it off", async ({ browser }) => {
    const motion = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1280, height: 800 } });
    const calm = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
    for (const [ctx, expected] of [[motion, true], [calm, false]] as const) {
      const page = await ctx.newPage();
      await page.goto("http://127.0.0.1:3210/jobs?nosplash");
      await ready(page);
      const dur = await page.locator(".app-frame").evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(parseFloat(dur) > 0.01, `transition-duration ${dur}`).toBe(expected);
      await ctx.close();
    }
  });
});

test.describe("phone drawer", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("closed it is out of the tab order; open it traps focus; Esc returns focus to the menu button", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    const menu = page.getByRole("button", { name: "Open menu" });
    await expect(sidebar(page)).toBeHidden(); // visibility: hidden: not focusable, not read
    await menu.click();
    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page).getByRole("button", { name: "Close menu" })).toBeFocused();
    expect(await page.locator("[data-behind-drawer]").evaluate((el) => el.hasAttribute("inert"))).toBe(true);

    // Tab never leaves the drawer
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#app-sidebar")), `tab stop ${i}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sidebar(page)).toBeHidden();
    await expect(menu).toBeFocused();
    expect(await page.locator("[data-behind-drawer]").evaluate((el) => el.hasAttribute("inert"))).toBe(false);
  });

  test("the backdrop closes it, and so does navigating", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.mouse.click(350, 400); // the dimmed page right of the 20 rem drawer (x > 320, left of the scrollbar gutter)
    await expect(sidebar(page)).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await sidebar(page).getByRole("link", { name: "Connections" }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await expect(sidebar(page)).toBeHidden();
  });

  test("Ctrl+B toggles the drawer on a phone-sized window", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    await page.keyboard.press("Control+b");
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(sidebar(page)).toBeHidden();
  });
});

test.describe("sidebar contents", () => {
  test("new chat, search (opens the palette), mode, appearance, settings, profile, budget and health", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    const sb = sidebar(page);
    await expect(sb.getByRole("link", { name: "New chat" })).toHaveAttribute("href", "/chat");
    await expect(sb.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
    await expect(sb.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    await sb.getByRole("radio", { name: "Pro" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-mode", "pro");
    await expect(sb.getByRole("button", { name: "Appearance" })).toBeVisible();
    await expect(sb.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    await expect(sb.getByRole("link", { name: /^Profile/ })).toHaveAttribute("href", "/settings#profile");
    await expect(sb.getByRole("meter", { name: "Today’s budget" })).toBeVisible();
    await expect(sb.getByRole("link", { name: /needs attention|Everything is running|with limits/ })).toBeVisible();
    await sb.getByRole("button", { name: "Open command palette" }).click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  });

  test("the slim page header names the section and has a slot for page actions", async ({ page }) => {
    await page.goto("/connections");
    await ready(page);
    await expect(page.locator(".page-header .page-title")).toHaveText("Connections");
    await expect(page.getByRole("group", { name: "Page actions" })).toBeAttached();
    expect((await page.locator(".page-header").boundingBox())!.height).toBeLessThanOrEqual(64);
  });

  test("the budget dial and health dot are not repeated in the footer", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    await expect(page.getByRole("contentinfo").getByRole("meter")).toHaveCount(0);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: /Open status/ })).toHaveCount(0);
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe · sidebar states · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    async function audit(page: Page, label: string) {
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad, `${label}\n` + bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`).join("\n")).toEqual([]);
    }

    test("expanded, with recents", async ({ page }) => {
      await page.goto(SEED);
      await ready(page);
      await expect(page.getByRole("region", { name: "Recent chats" }).getByRole("link").first()).toBeVisible();
      await audit(page, `expanded ${scheme}`);
    });

    test("collapsed rail", async ({ page }) => {
      await page.goto(SEED);
      await ready(page);
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
      await audit(page, `collapsed ${scheme}`);
    });

    test("phone drawer open", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(SEED);
      await ready(page);
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
      // the page behind the drawer is inert and dimmed on purpose: audit the drawer itself
      const r = await new AxeBuilder({ page })
        .include("#app-sidebar")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
    });
  });
}
