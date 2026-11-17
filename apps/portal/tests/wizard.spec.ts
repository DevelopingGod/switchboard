import { test, expect } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

// First run: the fixture router has no onboarding record. State is shared, so run in order.
test.describe.configure({ mode: "serial" });
test.use({ baseURL: urls.firstRun });

test("skipping, then resuming where it stopped", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/); // first run goes to the wizard
  await ready(page);
  await page.getByLabel("What should we call you?").fill("Riley");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to do?" })).toBeFocused();
  await page.getByLabel("Writing and content").check();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Home no longer redirects, offers to finish, and the greeting uses the saved name.
  await expect(page).toHaveURL(urls.firstRun + "/");
  await expect(page.getByRole("link", { name: "Finish setup" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Riley");

  await page.getByRole("link", { name: "Finish setup" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to do?" })).toBeVisible(); // resumed at goals
  await expect(page.getByLabel("Writing and content")).toBeChecked();
});

test("complete the wizard end to end", async ({ page }) => {
  await page.goto("/welcome?step=1"); // the previous test left the saved step at "goals"
  await ready(page);
  await page.getByRole("button", { name: "Continue" }).click();

  // Goals gate Continue, and the Connect step only shows providers those goals need.
  const next = page.getByRole("button", { name: "Continue" });
  for (const g of ["Writing and content"]) await page.getByLabel(g).uncheck();
  await expect(next).toBeDisabled();
  await page.getByLabel("Chat and quick answers").check();
  await page.getByLabel("Video").check();
  await next.click();

  const names = ["Groq", "Cerebras", "xAI (Grok API)"];
  for (const n of names) await expect(page.getByRole("article", { name: n })).toBeVisible();
  await expect(page.getByRole("article", { name: "xAI (Grok API)" }).getByText("Paid", { exact: true })).toBeVisible();
  // Mistral's free plan cannot activate API keys, so it is never offered as a goal's provider.
  for (const n of ["Mistral (La Plateforme)", "Google AI Studio (Gemini)", "OpenCode", "Ollama (local)"]) {
    await expect(page.getByRole("article", { name: n })).toHaveCount(0);
  }
  await next.click();

  await page.getByLabel("Free only").check();
  await next.click();

  await expect(page.getByRole("heading", { name: /You’re all set, Riley/ })).toBeVisible();
  await expect(page.getByText("Chat is live")).toBeVisible(); // "Try it" points to Chat now that routing ships (M2)
  await page.getByRole("button", { name: "Open Switchboard" }).click();
  await expect(page).toHaveURL(urls.firstRun + "/");
  await expect(page.getByRole("link", { name: "Finish setup" })).toHaveCount(0);

  // Done stays done: Home no longer sends anyone to the wizard.
  await page.goto("/");
  await expect(page).toHaveURL(urls.firstRun + "/");
});
