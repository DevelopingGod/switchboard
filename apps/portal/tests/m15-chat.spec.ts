import { test, expect, type Locator, type Page } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

const SEED = "/chat?t=6f1c2a10-0000-4000-8000-000000000001";
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Chats" });

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("no box");
  return b;
}
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe("sidebar (read-only)", () => {
  test("grouped by day, private lock, long titles truncate with the full title on hover", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const nav = sidebar(page);
    for (const g of ["Today", "Yesterday", "Previous 7 days", "Older"]) await expect(nav.getByRole("heading", { name: g })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Private: Notes on my health check" })).toBeVisible();

    const long = nav.getByRole("link", { name: /Trip ideas/ }).locator("[data-tip-truncated]");
    expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const navBox = await box(nav.locator(".sidebar-full"));
    const rowBox = await box(nav.getByRole("link", { name: /Trip ideas/ }));
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(navBox.x + navBox.width);
    expect(await nav.locator("[data-thread-scroll]").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    await page.waitForFunction(() => !!document.getElementById("sb-tip"));
    await long.hover();
    await expect(page.locator("#sb-tip")).toHaveText(/quiet beaches and good seafood/);
  });

  test("search filters titles and says when nothing matches", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const nav = sidebar(page);
    await nav.getByRole("searchbox", { name: "Search chats" }).fill("linkedin");
    await expect(nav.getByRole("link", { name: "Launch post for LinkedIn" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Why the sky is blue" })).toHaveCount(0);
    await nav.getByRole("searchbox", { name: "Search chats" }).fill("zzz");
    await expect(nav.getByRole("status")).toHaveText("No chats match “zzz”.");
  });

  test("one tab stop, arrow keys move between threads", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const nav = sidebar(page);
    const rows = nav.locator("[data-thread-row]");
    await expect(rows.and(page.locator("[tabindex='0']"))).toHaveCount(1);
    await nav.getByRole("link", { name: "Why the sky is blue" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(nav.getByRole("link", { name: "Launch post for LinkedIn" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(nav.getByRole("link", { name: /Trip ideas/ })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(nav.getByRole("link", { name: "Why the sky is blue" })).toBeFocused();
  });

  test("collapse to a rail and back (button and mod+B)", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    await page.getByRole("button", { name: "Hide chat list" }).click();
    await expect(page.getByRole("button", { name: "Show chat list" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeHidden();
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
  });

  test("phones: the list folds behind a Chats button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(SEED);
    await ready(page);
    await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeHidden();
    await page.getByRole("button", { name: /^Chats \(\d+\)$/ }).click();
    await expect(page.getByRole("searchbox", { name: "Search chats" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("conversation", () => {
  test("centred 760 px column, date separator, provider line per reply", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const list = page.getByRole("list", { name: "Chat" });
    expect((await box(list)).width).toBeLessThanOrEqual(760);
    await expect(list.locator(".date-sep")).toHaveText("Today");
    const replies = page.getByRole("article", { name: "Assistant" });
    await expect(replies.last()).toContainText("Google AI Studio (Gemini)");
    await expect(replies.first()).toContainText("gpt-oss-120b");
  });

  test("reply actions show on hover / focus; the last reply's always show", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const replies = page.getByRole("article", { name: "Assistant" });
    const firstActions = replies.nth(1).locator(".msg-actions");
    await page.mouse.move(5, 5);
    await expect(firstActions).toHaveCSS("opacity", "0");
    await replies.nth(1).hover();
    await expect(firstActions).toHaveCSS("opacity", "1");
    await expect(replies.last().locator(".msg-actions")).toHaveCSS("opacity", "1");
    await page.mouse.move(5, 5);
    await replies.nth(1).getByRole("button", { name: "Copy reply" }).focus();
    await expect(firstActions).toHaveCSS("opacity", "1");
  });

  test("scroll to latest appears away from the end and takes you there", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(SEED);
    await ready(page);
    const pill = page.getByRole("button", { name: "Scroll to latest" });
    await expect(pill).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveCount(0);
    expect(await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2)).toBe(true);
  });

  for (const size of [{ width: 1280, height: 900 }, { width: 1280, height: 640 }]) {
    test(`"Why this?" never covers the previous message (${size.height}px tall)`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto(SEED);
      await ready(page);
      const items = page.getByRole("list", { name: "Chat" }).locator(":scope > li:not(.date-sep)");
      const n = await items.count();
      for (let i = 1; i < n; i += 2) {
        const reply = items.nth(i);
        const prev = items.nth(i - 1);
        const chip = reply.getByRole("button", { name: /^Why this\?/ });
        await chip.scrollIntoViewIfNeeded();
        if (i === n - 1) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); // the hard case
        await chip.click();
        const pop = page.getByRole("dialog", { name: "Why this route?" });
        await expect(pop).toBeVisible();
        expect(overlap(await box(pop), await box(prev)), `reply ${i}: popover over the previous message`).toBe(false);
        const p = await box(pop);
        expect(p.y + p.height).toBeLessThanOrEqual(size.height + 1);
        await page.keyboard.press("Escape");
        await expect(pop).toBeHidden();
      }
    });
  }
});

test.describe("sidebar actions (mutating)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: urls.mutating });

  test("pin, rename (F2) and delete from the row menu", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const nav = sidebar(page);
    const row = nav.getByRole("link", { name: "Launch post for LinkedIn" });
    await row.hover();
    await nav.getByRole("button", { name: "More actions for Launch post for LinkedIn" }).click();
    const menu = page.getByRole("menu", { name: "More actions for Launch post for LinkedIn" });
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await menu.getByRole("menuitem", { name: "Pin" }).click();
    const pinned = nav.getByRole("region", { name: "Pinned" });
    await expect(pinned.getByRole("link", { name: "Launch post for LinkedIn" })).toBeVisible();
    await page.reload();
    await ready(page);
    await expect(sidebar(page).getByRole("region", { name: "Pinned" })).toContainText("Launch post for LinkedIn");

    await sidebar(page).getByRole("link", { name: "Launch post for LinkedIn" }).focus();
    await page.keyboard.press("F2");
    const input = sidebar(page).getByRole("textbox", { name: "Chat name" });
    await input.fill("Launch post v2");
    await page.keyboard.press("Enter");
    await expect(sidebar(page).getByRole("link", { name: "Launch post v2" })).toBeVisible();

    await sidebar(page).getByRole("link", { name: "Launch post v2" }).focus();
    await page.keyboard.press("Delete");
    const confirm = sidebar(page).getByRole("group", { name: "Delete “Launch post v2”?" });
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(sidebar(page).getByRole("link", { name: "Launch post v2" })).toHaveCount(0);
  });

  test("Esc closes the row menu and returns focus", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const nav = sidebar(page);
    const btn = nav.getByRole("button", { name: "More actions for Why the sky is blue" });
    await nav.getByRole("link", { name: "Why the sky is blue" }).hover();
    await btn.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(btn).toBeFocused();
  });
});
