import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready, settled } from "./helpers";

/**
 * M6: /metrics (Simple and Pro), table fallbacks and CSV export, the demo toggle, privacy of the per-request
 * list, the Agents "No cap" dial and Settings → Subscriptions. Fixture data (fixed dates); read-only checks use
 * the main fixture server, the subscriptions edit runs on the settings server.
 */

test.use({ timezoneId: "Asia/Kolkata" });

async function open(page: Page, path: string, mode: "simple" | "pro" = "simple") {
  // Fixture data is dated 21 Nov 2026 (noon UTC); "today 18:00" wording needs the same "now".
  await page.clock.setFixedTime(new Date("2026-11-21T12:00:00Z"));
  await page.goto(path);
  await ready(page);
  if (mode === "pro") await page.getByRole("complementary", { name: "Sidebar" }).getByRole("radio", { name: "Pro" }).click();
  // The page re-reads once in the browser's own time zone (first visit), then shows it.
  await expect(page.getByText(/^Times in Asia\/(Kolkata|Calcutta)\.$/)).toBeVisible();
}

async function csvOf(page: Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: dl.suggestedFilename(), text: await readFile((await dl.path())!, "utf8") };
}

test.describe("simple", () => {
  test("stats, insights, chart with a table view and CSV", async ({ page }) => {
    await open(page, "/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Metrics" })).toBeVisible();
    for (const label of ["Spent", "Value at API prices", "Net saved", "Requests", "Jobs done"]) {
      await expect(page.getByRole("article").filter({ hasText: label }).first()).toBeVisible();
    }
    await expect(page.getByText(/Value − \$\d+\.\d\d subscriptions/)).toBeVisible();
    const insights = page.getByRole("region", { name: "In short" });
    await expect(insights.getByText("Groq handled 62% of your chats for free.")).toBeVisible();
    await expect(insights.getByText("6 demo requests are left out.")).toBeVisible();

    const fig = page.getByRole("figure", { name: "Spend and value" });
    await expect(fig.getByRole("img")).toBeVisible();
    await expect(fig.getByRole("list", { name: /legend/ }).getByRole("listitem")).toHaveCount(2);
    await fig.getByRole("button", { name: "Show as table" }).click();
    const table = fig.getByRole("table", { name: "Spend and value" });
    await expect(table.getByRole("row")).toHaveCount(8); // header + 7 days
    await expect(fig.getByRole("img")).toHaveCount(0);

    const csv = await csvOf(page, () => fig.getByRole("button", { name: /Export CSV/ }).click());
    expect(csv.name).toMatch(/^switchboard-spend-and-value-7d-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.text.replace(/^﻿/, "").split("\r\n")[0]).toBe("When,Spent,Value at API prices");
  });

  test("range switch keeps the URL and redraws by hour", async ({ page }) => {
    await open(page, "/metrics");
    await page.getByRole("radiogroup", { name: "Time range" }).getByRole("radio", { name: "Today" }).click();
    await expect(page).toHaveURL(/range=today/);
    const fig = page.getByRole("figure", { name: "Spend and value" });
    await fig.getByRole("button", { name: "Show as table" }).click();
    await expect(fig.getByRole("rowheader", { name: "12:00" })).toBeVisible();
    await expect(page.getByText(/reach your daily cap \(\$1\.00\) at 18:00/)).toBeVisible();
  });

  test("hover shows the values for one slot", async ({ page }) => {
    await open(page, "/metrics");
    const svg = page.getByRole("figure", { name: "Spend and value" }).locator("svg[role=img]");
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    await svg.hover({ position: { x: box.width * 0.95, y: box.height * 0.5 } });
    await expect(page.getByRole("status").filter({ hasText: "21 Nov" })).toBeVisible();
  });

  test("no activity: a plain empty state with a first step", async ({ page }) => {
    await open(page, "/metrics?fixture=empty");
    await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start a chat" })).toHaveAttribute("href", "/chat");
  });
});

test.describe("pro", () => {
  test("breakdowns page and export; job agents show success", async ({ page }) => {
    await open(page, "/metrics", "pro");
    const bd = page.getByRole("region", { name: "Breakdown" });
    await expect(bd.getByRole("table")).toBeVisible();
    await expect(bd.getByRole("rowheader", { name: "Groq" })).toBeVisible();
    await bd.getByLabel("Break down by").selectOption("agent");
    await expect(bd.getByRole("columnheader", { name: "Success" })).toBeVisible();
    await expect(bd.getByRole("rowheader", { name: "Claude Code" })).toBeVisible();
    const csv = await csvOf(page, () => bd.getByRole("button", { name: /Export CSV/ }).click());
    expect(csv.name).toMatch(/breakdown-agent/);
  });

  test("errors, latency, quotas, budgets with forecast and No cap", async ({ page }) => {
    await open(page, "/metrics", "pro");
    await expect(page.getByRole("figure", { name: "Errors and fallbacks" })).toBeVisible();
    await expect(page.getByRole("figure", { name: "Response time" })).toBeVisible();
    const quotas = page.getByRole("region", { name: "Free quotas" });
    await expect(quotas.getByText(/620 \/ 1,000 requests per day/)).toBeVisible();
    await expect(quotas.getByText(/resets today 00:00|resets Sun 00:00|resets/).first()).toBeVisible();
    const budgets = page.getByRole("region", { name: "Budgets" });
    await expect(budgets.getByText("At this rate you’ll reach it today 18:00.")).toBeVisible();
    await expect(budgets.getByRole("listitem").filter({ hasText: "Codex this month" }).getByText("No cap").first()).toBeVisible();
  });

  test("top requests: titles only, private chats hidden, CSV safe from formulas", async ({ page }) => {
    await open(page, "/metrics", "pro");
    const top = page.getByRole("region", { name: "Most valuable requests" });
    await expect(top.getByRole("rowheader", { name: "Private chat" })).toBeVisible();
    await expect(top.getByRole("link", { name: "Fix the flaky login test" })).toHaveAttribute("href", "/jobs/12");
    const csv = await csvOf(page, () => top.getByRole("button", { name: /Export CSV/ }).click());
    expect(csv.text).toContain("'=SUM(A1:A3) budget sheet");
    expect(csv.text).not.toMatch(/\r\n=SUM/);
  });

  test("demo traffic can be included", async ({ page }) => {
    await open(page, "/metrics", "pro");
    await expect(page.getByText("6 demo requests are left out.")).toBeVisible();
    await page.getByRole("checkbox", { name: "Include demo traffic" }).check();
    await expect(page.getByText("6 demo requests are left out.")).toHaveCount(0);
  });

  test("Simple mode shows no Pro sections", async ({ page }) => {
    await open(page, "/metrics");
    await settled(page);
    await expect(page.getByRole("region", { name: "Breakdown" })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Include demo traffic" })).toHaveCount(0);
  });
});

test("agents: the dial shows No cap without a monthly budget", async ({ page }) => {
  await page.goto("/jobs/agents");
  await ready(page);
  const cards = page.getByRole("article");
  const noCap = cards.filter({ hasText: "No monthly cap" }).first();
  const dial = noCap.getByRole("meter", { name: "Monthly budget" });
  await expect(dial).toHaveAttribute("aria-valuetext", "No monthly cap");
  await expect(noCap.getByText("No cap", { exact: true })).toBeVisible();
});

test.describe("settings · subscriptions", () => {
  test.describe.configure({ mode: "serial" });
  test("add, validate and save a plan", async ({ page }) => {
    await page.goto(`${urls.settings}/settings#subscriptions`);
    await ready(page);
    const sec = page.getByRole("region", { name: "Subscriptions" });
    await expect(sec.getByRole("textbox", { name: "Plan" }).first()).toHaveValue("Claude Pro");
    await sec.getByRole("button", { name: "Add a subscription" }).click();
    await sec.getByRole("button", { name: "Save subscriptions" }).click();
    await expect(sec.getByRole("alert")).toHaveText(/needs a name, a fee/);
    await sec.getByRole("textbox", { name: "Plan" }).nth(1).fill("ChatGPT Plus");
    await sec.getByRole("textbox", { name: "Monthly fee (USD)" }).nth(1).fill("20");
    await sec.getByRole("button", { name: "Save subscriptions" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Subscriptions saved" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Subscriptions" }).getByRole("textbox", { name: "Plan" })).toHaveCount(2);
  });
});
