import { test, expect } from "@playwright/test";
import { inPro, ready } from "./helpers";

/**
 * M3b review fixes: Simple mode is plain language only (no rule names, scores, runner-up, skipped list),
 * the sidebar has one search, and recents never show an empty group.
 */
const SEED = "/chat?t=6f1c2a10-0000-4000-8000-000000000001";
const sidebar = (page: import("@playwright/test").Page) => page.getByRole("complementary", { name: "Sidebar" });

test.describe("Why this? in Simple mode", () => {
  test("provider and model, one plain reason, the price; nothing about rules", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    // the chip itself doesn't name a rule either
    const chip = page.getByRole("button", { name: /Why this\? Routed to Google AI Studio/ });
    expect(await chip.getAttribute("aria-label")).not.toMatch(/rule/);
    await expect(chip).not.toContainText(/rule/);
    await chip.click();
    const pop = page.getByRole("dialog", { name: "Why this route?" });
    await expect(pop).toContainText("Google AI Studio");
    await expect(pop).toContainText("gemini-3.1-flash-lite");
    await expect(pop).toContainText("Your first choice was busy, so this one answered."); // the seeded reply fell back
    await expect(pop).toContainText("Free");
    const text = await pop.innerText();
    for (const banned of [/Rule\b/, /Runner-up/i, /Skipped/i, /Top reasons/i, /score/i, /default/i, /tokens/i, /Request #/, /first token/i]) expect(text, String(banned)).not.toMatch(banned);
    expect(text.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(8);
  });

  test("Pro keeps the full breakdown", async ({ page }) => {
    await inPro(page);
    await page.goto(SEED);
    await ready(page);
    await page.getByRole("button", { name: /Why this\? Routed to Google AI Studio.* by rule default/ }).click();
    const pop = page.getByRole("dialog", { name: "Why this route?" });
    for (const s of ["Rule", "Runner-up", "Tokens", "Latency"]) await expect(pop).toContainText(s);
  });
});

test.describe("one search in the sidebar", () => {
  test("a single field filters the chats; the ⌘K button opens the full palette", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    await expect(page.getByRole("searchbox")).toHaveCount(1);
    await expect(sidebar(page).getByRole("button", { name: /^Search$/ })).toHaveCount(0);
    const field = sidebar(page).getByRole("searchbox", { name: "Search chats" });
    await field.fill("linkedin");
    const recents = page.getByRole("region", { name: "Recent chats" });
    await expect(recents.getByRole("link", { name: "Launch post for LinkedIn" })).toBeVisible();
    await expect(recents.getByRole("link", { name: "Why the sky is blue" })).toHaveCount(0);
    await sidebar(page).getByRole("button", { name: /Open command palette/ }).click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  });

  test("collapsed rail: one palette button, no field", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByRole("searchbox")).toBeHidden();
    await expect(sidebar(page).getByRole("button", { name: /Open command palette/ }).and(page.locator(":visible"))).toHaveCount(1);
  });
});

test.describe("recents groups", () => {
  test("every group heading has at least one chat under it, and a search drops empty groups", async ({ page }) => {
    await page.goto(SEED);
    await ready(page);
    const recents = page.getByRole("region", { name: "Recent chats" });
    const check = async () => {
      const bad = await recents.locator("section[aria-labelledby^='tg-']").evaluateAll((els) => els.filter((e) => e.querySelectorAll("a[data-thread-row]").length === 0).map((e) => e.getAttribute("aria-labelledby")));
      expect(bad, "groups with no chats").toEqual([]);
    };
    await check();
    expect(await recents.locator("h3").count()).toBeGreaterThan(0);
    await sidebar(page).getByRole("searchbox", { name: "Search chats" }).fill("sky");
    await expect(recents.getByRole("link", { name: "Why the sky is blue" })).toBeVisible();
    await expect(recents.getByRole("heading", { name: "Older" })).toHaveCount(0);
    await check();
  });
});
