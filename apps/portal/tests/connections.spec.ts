import { test, expect } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

// These tests change fixture state (keys, installs), so they use their own server and run in order.
test.describe.configure({ mode: "serial" });
test.use({ baseURL: urls.mutating });

const card = (page: import("@playwright/test").Page, name: string) => page.getByRole("article", { name });

test("add, test and remove an API key from the UI", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  const c = card(page, "Cerebras");
  await expect(c.getByText("Not connected")).toBeVisible();

  await c.getByRole("button", { name: "Add key" }).click();
  const input = c.getByLabel("Cerebras API key");
  await expect(input).toHaveAttribute("type", "password");

  // A rejected key shows the router's message and stores nothing.
  await input.fill("bad-key-0000");
  await c.getByRole("button", { name: "Check and save" }).click();
  await expect(c.getByRole("alert")).toContainText("rejected this key");
  await expect(c.getByText("Not connected")).toBeVisible();

  await input.fill("csk-test-key-4321");
  await c.getByRole("button", { name: "Check and save" }).click();
  await expect(c.getByText("Connected", { exact: true })).toBeVisible();
  await expect(c.getByText("Key ending 4321")).toBeVisible();
  await expect(page.getByText(/csk-test-key/)).toHaveCount(0); // the key is never echoed back

  await c.getByRole("button", { name: "Test connection" }).click();
  await expect(c.getByRole("status").filter({ hasText: "Cerebras is working." })).toBeVisible();

  await c.getByRole("button", { name: "Remove key" }).click();
  await expect(c.getByRole("alertdialog")).toContainText("Remove this key?");
  await c.getByRole("button", { name: "Yes, remove it" }).click();
  await expect(c.getByText("Not connected")).toBeVisible();
  await expect(c.getByText("Key ending")).toHaveCount(0);
});

test("provider cards show tagged model badges and a per-model Test", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  const groq = card(page, "Groq");
  const best = groq.getByRole("listitem").filter({ hasText: "GPT-OSS 120B" });
  for (const badge of ["Best for code", "Fastest", "Free"]) await expect(best.getByText(badge)).toBeVisible();
  await expect(groq.getByText("Largest context")).toBeVisible();
  await expect(card(page, "Google AI Studio (Gemini)").getByText("1 more models are not tagged yet.")).toBeVisible();

  await best.getByRole("button", { name: "Test GPT-OSS 120B" }).click();
  await expect(best.getByText(/Answered in \d+ ms/)).toBeVisible();
});

test("install OpenCode through the UI with confirmation, then see the login step", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  const c = card(page, "OpenCode");
  await expect(c.getByText("Not installed")).toBeVisible();

  await c.getByRole("button", { name: "Install" }).click();
  const dialog = page.getByRole("dialog", { name: "Install OpenCode" });
  // Everything is shown first, and nothing has run yet.
  await expect(dialog.getByRole("link", { name: /opencode\.ai\/install/ })).toBeVisible();
  await expect(dialog.getByText("Never uses sudo.")).toBeVisible();
  await expect(dialog.getByText("bash install.sh --version 1.19.6 --no-modify-path")).toBeVisible();
  await expect(dialog.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
  // The page behind a modal is hidden from the accessibility tree, so look it up with includeHidden.
  await expect(page.getByRole("article", { name: "OpenCode", includeHidden: true }).getByText("Not installed")).toBeVisible();

  await dialog.getByRole("button", { name: "Install OpenCode" }).click();
  const log = dialog.getByRole("log", { name: "Install log" });
  await expect(log).toContainText("Installing opencode 1.19.6");
  await expect(dialog.getByText("OpenCode is installed.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();

  // The card flipped, and the login step (a terminal command, never an in-portal OAuth) is shown.
  await expect(c.getByText("Not logged in")).toBeVisible();
  await expect(c.getByText("opencode auth login")).toBeVisible();
  await c.getByRole("button", { name: "Check again" }).click();
  await expect(c.getByText(/Still not logged in/)).toBeVisible();
});

test("the browser never receives the admin token", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url(), JSON.stringify(r.headers())));
  await page.goto("/connections");
  await ready(page);
  expect(seen.join("\n")).not.toMatch(/authorization|bearer|ROUTER_ADMIN_TOKEN/i);
});
