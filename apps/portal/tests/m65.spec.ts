import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

/**
 * M6.5: subscription usage windows (Agents, Status, Metrics, New job), the job waiting for a reset and what
 * you can do instead, Settings → Accounts and Paid overflow, per-project accounts, and the custom Metrics
 * range. Fixture data is dated 20 Nov 2026 (UTC); read-only checks use the main fixture server, anything
 * that changes state runs serially on the mutating server.
 */

const NOW = new Date("2026-11-20T10:00:00Z");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

async function open(page: Page, path: string, mode: "simple" | "pro" = "simple") {
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await ready(page);
  if (mode === "pro") await sidebar(page).getByRole("radio", { name: "Pro" }).click();
}

async function axe(page: Page, label: string, scope?: string) {
  const b = new AxeBuilder({ page });
  if (scope) b.include(scope);
  const r = await b.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad, `${label}\n` + bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`).join("\n")).toEqual([]);
}

test.describe("read-only", () => {
  test("agents: each subscription agent shows its usage window, reported or estimated", async ({ page }) => {
    await open(page, "/jobs/agents");
    const claude = page.getByRole("article", { name: "Claude Code", exact: true });
    await expect(claude.getByText("Claude Pro · default")).toBeVisible();
    await expect(claude.getByText(/^70% of this 5-hour window · resets 02:20 PM$/)).toBeVisible();
    await expect(claude.getByText("reported by the CLI")).toBeVisible();
    await expect(claude.getByRole("meter", { name: "Usage window" })).toHaveAttribute("aria-valuenow", "70");
    const codex = page.getByRole("article", { name: "Codex", exact: true });
    await expect(codex.getByText("3 run(s) in this 5-hour window, no reading yet")).toBeVisible(); // never a made-up %
    await expect(codex.getByText("estimate", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Reviewer" }).getByText("Claude Team · work")).toBeVisible();
    await expect(page.getByRole("article", { name: "OpenCode", exact: true }).getByTestId("window-meter")).toHaveCount(0);
    await expect(claude.getByText(/7-day/)).toHaveCount(0); // the other windows are Pro detail
    const paid = page.getByRole("article", { name: "Paid overflow (OpenCode)" });
    await expect(paid.getByText("Paid · only when you confirm")).toBeVisible(); // never "Ready" like the others
    await sidebar(page).getByRole("radio", { name: "Pro" }).click();
    await expect(claude.getByText(/^12% of this 7-day window · resets Tue 02:20 PM$/)).toBeVisible();
  });

  test("board: a Waiting tab and the reset time on the row", async ({ page }) => {
    await open(page, "/jobs");
    const tabs = page.getByRole("navigation", { name: "Status" });
    await tabs.getByRole("link", { name: /Waiting\s*1/ }).click();
    await expect(page).toHaveURL(/status=waiting_reset/);
    const list = page.getByRole("region", { name: "Jobs" }).getByRole("list", { name: "Jobs" });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list.getByText("Resumes at 02:20 PM")).toBeVisible();
  });

  test("job waiting for a reset: when it resumes and what you can do instead", async ({ page }) => {
    await open(page, "/jobs/31");
    const panel = page.getByTestId("limit-panel");
    await expect(panel.getByRole("heading", { name: "Waiting for the usage limit to reset" })).toBeVisible();
    await expect(panel.getByText("Resumes at 02:20 PM")).toBeVisible();
    await expect(panel.getByText("Attempt 2")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Wait anyway" })).toHaveCount(0); // only for a far reset
    await panel.getByRole("button", { name: "Run on another agent" }).click();
    const pick = panel.getByLabel("Agent");
    await expect(pick).toBeVisible();
    const options = await pick.locator("option").allTextContents();
    expect(options).toContain("Codex");
    expect(options).not.toContain("Claude Code"); // never another account of the same provider
    expect(options).not.toContain("Reviewer");
    await expect(panel.getByText("Another provider only: Switchboard never switches accounts of one provider.")).toBeVisible();
    await panel.getByRole("button", { name: "Use paid overflow" }).click();
    await expect(panel.getByText("Paid overflow is off (Settings → Subscriptions).")).toBeVisible();
    await panel.getByRole("button", { name: "Cancel job" }).click();
    await expect(panel.getByRole("alertdialog")).toBeVisible();
  });

  test("status: subscription accounts and the Metrics rollup worker", async ({ page }) => {
    await open(page, "/status");
    await expect(page.getByText("Claude Pro · default")).toBeVisible();
    await expect(page.getByText(/^70% of this 5-hour window · resets .* · reported by the CLI$/)).toBeVisible();
    await expect(page.getByText("Metrics rollups")).toBeVisible();
    await expect(page.getByText("Up to date")).toBeVisible();
  });

  test("metrics: a custom range, checked before it loads", async ({ page }) => {
    await open(page, "/metrics");
    await page.getByRole("radiogroup", { name: "Time range" }).getByRole("radio", { name: "Custom" }).click();
    const form = page.getByRole("form", { name: "Custom" });
    await form.getByLabel("From").fill("2026-11-20");
    await form.getByLabel("To").fill("2026-11-10");
    await form.getByRole("button", { name: "Show" }).click();
    await expect(form.getByRole("alert")).toHaveText("The first day must come before the last.");
    await form.getByLabel("From").fill("2026-11-10");
    await form.getByLabel("To").fill("2026-11-20");
    await form.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/range=custom&first=2026-11-10&last=2026-11-20/);
    await expect(form.getByRole("alert")).toHaveCount(0);
    // A shared link opens the same range.
    await open(page, "/metrics?range=custom&first=2026-11-10&last=2026-11-20", "pro");
    await expect(page.getByRole("radiogroup", { name: "Time range" }).getByRole("radio", { name: "Custom" })).toBeChecked();
    const subs = page.getByRole("region", { name: "Subscription windows" });
    await expect(subs.getByText("1 limit hit(s) in 30 days")).toBeVisible();
    await expect(subs.getByText("Claude Pro · default")).toBeVisible();
  });

  test("settings: accounts per CLI, and paid overflow off by default", async ({ page }) => {
    await open(page, "/settings");
    const acc = page.getByRole("region", { name: "Accounts" });
    await expect(acc.getByText("Switchboard never switches to another account of the same provider to get around a limit (FAQ).")).toBeVisible();
    await expect(acc.getByText("default (the CLI's own login)").first()).toBeVisible();
    await expect(acc.getByText("~/.switchboard/accounts/claude/work")).toBeVisible();
    const ov = page.getByRole("region", { name: "Paid overflow" });
    await expect(ov.getByLabel("Allow paid overflow")).not.toBeChecked();
  });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(`axe · ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      test("agents (Pro), waiting job with its options open, status, settings, custom metrics", async ({ page }) => {
        await open(page, "/jobs/agents", "pro");
        await axe(page, `agents pro ${scheme}`);
        await open(page, "/jobs/31");
        const panel = page.getByTestId("limit-panel");
        await panel.getByRole("button", { name: "Run on another agent" }).click();
        await panel.getByLabel("Agent").waitFor();
        await axe(page, `job 31 another ${scheme}`);
        await panel.getByRole("button", { name: "Use paid overflow" }).click();
        await panel.getByText("Paid overflow is off (Settings → Subscriptions).").waitFor();
        await axe(page, `job 31 paid ${scheme}`);
        await open(page, "/jobs?status=waiting_reset");
        await axe(page, `board waiting ${scheme}`);
        await open(page, "/status");
        await axe(page, `status ${scheme}`);
        await open(page, "/settings");
        await axe(page, `settings ${scheme}`);
        await open(page, "/settings/projects");
        await axe(page, `projects ${scheme}`);
        await open(page, "/metrics?range=custom&first=2026-11-10&last=2026-11-20", "pro");
        await page.getByRole("region", { name: "Subscription windows" }).waitFor();
        await axe(page, `metrics custom ${scheme}`);
      });
    });
  }
});

test.describe("changes", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: urls.mutating });

  test("add an account: the folder's login command, then remove it", async ({ page }) => {
    await open(page, "/settings");
    const acc = page.getByRole("region", { name: "Accounts" });
    await acc.getByLabel("Name").fill("personal");
    await acc.getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Account “personal” added" })).toBeVisible();
    await expect(acc.getByText("CLAUDE_CONFIG_DIR=~/.switchboard/accounts/claude/personal claude auth login").first()).toBeVisible();
    await expect(acc.getByText("Not logged in")).toBeVisible();
    await acc.getByLabel("Name").fill("Bad Name");
    await acc.getByRole("button", { name: "Add account" }).click();
    await expect(acc.getByRole("alert")).toHaveText("Lowercase letters, digits and dashes, for example work.");
    const item = acc.getByRole("listitem").filter({ hasText: "personal" });
    await item.getByRole("button", { name: "Remove" }).click();
    await item.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Account “personal” removed" })).toBeVisible();
  });

  test("a project chooses its account; a used account can't be removed", async ({ page }) => {
    await open(page, "/settings/projects");
    const proj = page.getByRole("article", { name: "notes-app" });
    await proj.getByLabel("Account · Claude").selectOption("work");
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    await open(page, "/settings");
    const item = page.getByRole("region", { name: "Accounts" }).getByRole("listitem").filter({ hasText: "Company Team seat" });
    await item.getByRole("button", { name: "Remove" }).click();
    await item.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(item.getByRole("alert")).toContainText("still used by");
  });

  test("a far reset asks first; Wait anyway lets it wait", async ({ page }) => {
    await open(page, "/jobs");
    await page.getByRole("button", { name: "New job" }).first().click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Task").fill("[fixture:limit] Add a function power(a, b) with tests");
    await dlg.getByRole("button", { name: "Review" }).click();
    await dlg.getByRole("button", { name: "Start job" }).click();
    await expect(page).toHaveURL(/\/jobs\/\d+$/);
    const panel = page.getByTestId("limit-panel");
    await expect(panel.getByRole("heading", { name: "The usage limit resets in a long time" })).toBeVisible();
    await expect(page.getByText("Wait for the reset?").first()).toBeVisible();
    await panel.getByRole("button", { name: "Wait anyway" }).click();
    await expect(panel.getByRole("heading", { name: "Waiting for the usage limit to reset" })).toBeVisible();
    await panel.getByRole("button", { name: "Run on another agent" }).click();
    await panel.getByLabel("Agent").selectOption({ label: "Codex" });
    await panel.getByRole("button", { name: "Run on Codex" }).click();
    await expect(page.getByTestId("limit-panel")).toHaveCount(0);
  });

  test("paid overflow: turned on with a budget, then confirmed per job", async ({ page }) => {
    await open(page, "/settings");
    const ov = page.getByRole("region", { name: "Paid overflow" });
    await ov.getByLabel("Allow paid overflow").check();
    await ov.getByRole("button", { name: "Save" }).click();
    await expect(ov.getByRole("alert")).toHaveText("Set a monthly budget to turn it on.");
    await ov.getByLabel("Monthly budget (USD)").fill("5");
    await ov.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Paid overflow saved" })).toBeVisible();
    await open(page, "/jobs/31");
    const panel = page.getByTestId("limit-panel");
    await panel.getByRole("button", { name: "Use paid overflow" }).click();
    await expect(panel.getByText(/Runs on grok through LiteLLM and may spend up to \$1\.00 of real money/)).toBeVisible();
    await panel.getByRole("button", { name: "Paid — up to $1.00" }).click();
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("limit-panel")).toHaveCount(0);
  });
});
