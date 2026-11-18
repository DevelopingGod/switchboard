import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

// Settings change fixture state (name, caps, chats), so these run in order on their own server.
test.describe.configure({ mode: "serial" });
test.use({ baseURL: urls.settings });

const section = (page: Page, name: string) => page.getByRole("region", { name });

test("all sections, with a section nav", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  const names = ["Profile", "Goals & preset", "Appearance", "Privacy", "Budgets", "Data", "Run setup again"];
  for (const n of names) await expect(section(page, n)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("link", { name: "Budgets" }).click();
  await expect(page).toHaveURL(/#budgets$/);
});

test("profile name saves", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  const s = section(page, "Profile");
  await s.getByLabel("Your name").fill("Robin");
  await s.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Robin");
});

test("appearance: theme, motion and ambient cursor apply at once", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  const s = section(page, "Appearance");
  await s.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dusk" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await s.getByRole("radiogroup", { name: "Motion" }).getByRole("radio", { name: "Reduce" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await s.getByRole("switch", { name: "Ambient cursor" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-cursor", "off");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce"); // kept (before paint)
});

test("privacy default starts new chats as Private", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  await section(page, "Privacy").getByRole("switch", { name: "Start new chats as Private" }).click();
  await expect(page.getByText("Saved").first()).toBeVisible();
  await page.goto("/chat");
  await ready(page);
  await expect(page.getByRole("switch", { name: "Private" })).toHaveAttribute("aria-checked", "true");
  await page.goto("/settings");
  await section(page, "Privacy").getByRole("switch", { name: "Start new chats as Private" }).click();
});

test("budgets: validation, save, back to default", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  const s = section(page, "Budgets");
  await s.getByLabel("Daily cap (US$)").fill("lots");
  await s.getByRole("button", { name: "Save" }).click();
  await expect(s.getByRole("alert")).toHaveText("Enter an amount between 0 and 100, like 0.50.");
  await s.getByLabel("Per-request cap (US$)").fill("0.25");
  await s.getByLabel("Daily cap (US$)").fill("2");
  await s.getByRole("button", { name: "Save" }).click();
  await expect(s.getByText("of $2.00").first()).toBeVisible();
  await page.reload();
  await expect(section(page, "Budgets").getByLabel("Daily cap (US$)")).toHaveValue("2");
  await section(page, "Budgets").getByRole("button", { name: "Use default" }).click();
  await expect(section(page, "Budgets").getByLabel("Daily cap (US$)")).toHaveValue("1");
});

test("data: export JSON and Markdown (private only when asked)", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  const s = section(page, "Data");
  const [json] = await Promise.all([page.waitForEvent("download"), s.getByRole("link", { name: "Download JSON" }).click()]);
  expect(json.suggestedFilename()).toMatch(/^switchboard-chats-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync((await json.path())!, "utf8")) as { threads: { title: string; private: boolean }[] };
  expect(data.threads.map((t) => t.title)).toContain("Why the sky is blue");
  expect(data.threads.some((t) => t.private)).toBe(false);

  await s.getByRole("switch", { name: "Include private chats" }).click();
  const [md] = await Promise.all([page.waitForEvent("download"), s.getByRole("link", { name: "Download Markdown" }).click()]);
  const text = readFileSync((await md.path())!, "utf8");
  expect(text).toContain("# Switchboard chats");
  expect(text).toContain("Notes on my health check");
});

test("run setup again: prefilled, nothing saved until Finish, Cancel returns", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  await section(page, "Run setup again").getByRole("link", { name: "Run setup again" }).click();
  await expect(page).toHaveURL(/\/welcome\?step=1&again=1/);
  const name = page.getByLabel("What should we call you?");
  await expect(name).toHaveValue("Robin"); // prefilled
  await name.fill("Alex");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Cancel (keep current setup)" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(section(page, "Profile").getByLabel("Your name")).toHaveValue("Robin"); // not saved

  await page.goto("/welcome?step=1&again=1");
  await page.getByLabel("What should we call you?").fill("Alex");
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(section(page, "Profile").getByLabel("Your name")).toHaveValue("Alex");
});

test("data: clear all chats needs the word, axe clean with the dialog open", async ({ page }) => {
  await page.goto("/settings");
  await ready(page);
  await section(page, "Data").getByRole("button", { name: "Clear chats…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete every chat?" });
  const yes = dialog.getByRole("button", { name: "Delete all chats" });
  await expect(yes).toBeDisabled();
  const results = await new AxeBuilder({ page }).include("[role=dialog]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await dialog.getByLabel("Type delete to confirm").fill("delete");
  await yes.click();
  await expect(page.getByText("All chats deleted")).toBeVisible();
  await page.goto("/chat");
  await expect(page.getByText("No chats yet. Ask anything below.")).toBeVisible();
});
