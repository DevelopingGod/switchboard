import { expect, test, type Page } from "@playwright/test";
import { ready, settled } from "../helpers";

/**
 * Fails on any console error (React reports its warnings there) or uncaught page error on the main
 * pages. Development build only: see playwright.console.config.ts.
 */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") seen.push(`console: ${m.text().slice(0, 600)} (${m.location().url})`);
  });
  page.on("pageerror", (e) => seen.push(`page: ${e.message}`));
  return seen;
}

async function visit(page: Page, path: string) {
  await page.goto(path);
  await ready(page);
  await settled(page);
}

async function pro(page: Page) {
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("radio", { name: "Pro" }).click();
  await settled(page);
}

async function metricsPro(page: Page) {
  await visit(page, "/metrics");
  await pro(page);
  for (const name of ["Free quotas", "Budgets"]) await page.getByRole("region", { name }).getByRole("meter").first().waitFor();
  await page.getByRole("region", { name: "Most valuable requests" }).getByRole("table").waitFor();
}

const PAGES = ["/", "/chat", "/chat?t=6f1c2a10-0000-4000-8000-000000000001", "/jobs", "/metrics", "/connections", "/settings"];

for (const path of PAGES) {
  for (const mode of ["simple", "pro"] as const) {
    test(`no console errors: ${path} (${mode})`, async ({ page }) => {
      const errors = watch(page);
      await visit(page, path);
      if (mode === "pro") await pro(page);
      expect(errors).toEqual([]);
    });
  }
}

test("no console errors: Metrics Pro with every section loaded", async ({ page }) => {
  const errors = watch(page);
  await metricsPro(page);
  await settled(page);
  expect(errors).toEqual([]);
});

// The bug this guard came from: a counter and a header window for the same limit gave duplicate keys.
test("a counter and a header number for one limit don't collide", async ({ page }) => {
  const errors = watch(page);
  const w = { window: "minute", fraction: 0.2, used: 6, limit: 30, resets_at: null };
  const windows = ["requests", "tokens"].flatMap((kind) => ["counter", "headers"].map((source) => ({ ...w, kind, source })));
  await page.route(/\/api\/metrics\?.*view=quotas/, (route) =>
    route.fulfill({ json: { ok: true, data: { providers: [{ provider: "groq", name: "Groq", model: null, limits_note: null, windows }], subscriptions: [] } } }),
  );
  await metricsPro(page);
  await expect(page.getByRole("region", { name: "Free quotas" }).getByText(/6 \/ 30/)).toHaveCount(4);
  expect(errors).toEqual([]);
});
