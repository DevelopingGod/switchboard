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

test("Cerebras free credits: enter a starting balance and see what is left", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  const c = card(page, "Cerebras");
  await expect(c.getByText("One-time free credits")).toBeVisible();
  await expect(c.getByText("Free credits", { exact: true })).toHaveCount(0); // nothing until a key exists

  await c.getByRole("button", { name: "Add key" }).click();
  await c.getByLabel("Cerebras API key").fill("csk-test-key-4321");
  await c.getByRole("button", { name: "Check and save" }).click();
  await expect(c.getByText("Key ending 4321")).toBeVisible();
  await expect(c.getByText("Enter what your free credits started at")).toBeVisible();

  await c.getByRole("button", { name: "Set balance" }).click();
  await c.getByLabel("Starting balance (US dollars)").fill("lots");
  await c.getByRole("button", { name: "Save balance" }).click();
  await expect(c.getByRole("alert")).toContainText("Enter an amount in dollars");

  await c.getByLabel("Starting balance (US dollars)").fill("$5");
  await c.getByRole("button", { name: "Save balance" }).click();
  await expect(c.getByText("$5.00 left of $5.00")).toBeVisible();
  await expect(c.getByRole("meter", { name: "Free credits" })).toBeVisible();
  await expect(c.getByRole("button", { name: "Change balance" })).toBeVisible();

  await c.getByRole("button", { name: "Change balance" }).click();
  await c.getByLabel("Starting balance (US dollars)").fill("0");
  await c.getByRole("button", { name: "Save balance" }).click();
  await expect(c.getByText("Credits used up.")).toBeVisible();

  await c.getByRole("button", { name: "Remove key" }).click();
  await c.getByRole("button", { name: "Yes, remove it" }).click();
  await expect(c.getByText("Not connected")).toBeVisible();
});

test("Mistral is labelled paid and Gemini CLI says to use an API key", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  const m = card(page, "Mistral (La Plateforme)");
  await expect(m.getByText("Paid", { exact: true })).toBeVisible();
  await expect(m.getByText("free plan cannot activate API keys").first()).toBeVisible();
  const g = card(page, "Gemini CLI");
  await expect(g.getByText("Google sign-in no longer works for individuals")).toBeVisible();
  await expect(g.getByText("Shares the Gemini API free quota with smart-free", { exact: false })).toBeVisible();
  await expect(g.getByText(/Login with Google/)).toHaveCount(0);
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

  // Stages above one progress bar; the raw log is tucked into a collapsed "Details".
  const stages = dialog.getByRole("list", { name: "Install stages" });
  await expect(stages.getByRole("listitem")).toHaveText(["Downloading", "Installing", "Verifying", "Done"]);
  await expect(dialog.getByRole("progressbar", { name: "Download progress" })).toBeVisible();
  await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
  await expect(dialog.getByRole("button", { name: "Stop install" })).toBeVisible();

  // Success: a check, the version, a "Done" button (no more "Stop install") and the login step.
  await expect(dialog.getByText("OpenCode 1.19.6 installed")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Stop install" })).toHaveCount(0);
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Log in next" })).toBeVisible();
  await expect(dialog.getByText("opencode auth login", { exact: true }).first()).toBeVisible();

  // opencode lands off a new terminal's PATH: the one-line fix comes first, then login, then the full path.
  await expect(dialog.getByText("1. Add opencode to your PATH")).toBeVisible();
  await expect(dialog.getByText(`echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`)).toBeVisible();
  await expect(dialog.getByText("~/.opencode/bin/opencode auth login", { exact: true })).toBeVisible();
  for (const name of ["Copy PATH command", "Copy login command", "Copy full-path command"]) {
    await expect(dialog.getByRole("button", { name })).toBeVisible();
  }

  // Details holds the raw log, with the progress redraws collapsed into a single line.
  await dialog.locator("summary").filter({ hasText: "Details" }).click();
  const log = dialog.getByRole("log", { name: "Install log" });
  await expect(log).toContainText("Verifying checksum… ok");
  const text = (await log.innerText()).split("\n");
  expect(text.filter((l) => l.includes("%"))).toHaveLength(1);

  await dialog.getByRole("button", { name: "Done" }).click();

  // The card flipped, and shows the same login steps (a terminal command, never an in-portal OAuth).
  await expect(c.getByText("Not logged in")).toBeVisible();
  await expect(c.getByText("opencode auth login", { exact: true }).first()).toBeVisible();
  await c.getByRole("button", { name: "Check again" }).click();
  await expect(c.getByText(/Still not logged in/)).toBeVisible();
});

test("a failed install shows an error summary and the last 20 lines", async ({ page }) => {
  await page.goto("/connections");
  await ready(page);
  await card(page, "Claude Code").getByRole("button", { name: "Install" }).click();
  const dialog = page.getByRole("dialog", { name: "Install Claude Code" });
  await dialog.getByRole("button", { name: "Install Claude Code" }).click();

  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("The install failed");
  await expect(alert).toContainText("Install failed: could not download claude 2.1.311");
  await expect(alert.getByText("Last 20 lines")).toBeVisible();
  const tail = (await alert.locator("pre").innerText()).split("\n");
  expect(tail).toHaveLength(20);
  expect(tail.at(-1)).toContain("Install failed");
  await expect(dialog.getByText("OpenCode 1.19.6 installed")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Review again" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).first().click();
  await expect(card(page, "Claude Code").getByText("Windows only")).toBeVisible(); // nothing changed
});

test("the browser never receives the admin token", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url(), JSON.stringify(r.headers())));
  await page.goto("/connections");
  await ready(page);
  expect(seen.join("\n")).not.toMatch(/authorization|bearer|ROUTER_ADMIN_TOKEN/i);
});
