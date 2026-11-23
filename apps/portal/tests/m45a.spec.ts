import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { urls } from "../playwright.config";
import { inPro, ready } from "./helpers";

/**
 * M4.5a: workflow packs. The library (Connections → Workflow packs: install plan → confirm → log, refused global-only
 * packs), per-project settings, an OpenSpec workflow job (a review after each step), pack setup edits in the diff
 * review (unticked by default), graphify's measuring in Metrics Pro, and the Data export warning. Fixture data.
 */

// Installs, settings and new jobs change fixture state: the mutating server.
const M = urls.mutating;

async function axe(page: Page, scope?: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
    if (scope) b.include(scope);
    const results = await b.analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  }
}

const packs = (page: Page) => page.getByRole("region", { name: "Workflow packs" });
const card = (page: Page, name: string) => packs(page).getByRole("article", { name });

test.describe("pack library", () => {
  test("lists packs: installed, installable, and refused with the reason", async ({ page }) => {
    await page.goto("/connections");
    await ready(page);
    await expect(packs(page)).toContainText("never into your Claude or Codex folders");
    await expect(card(page, "OpenSpec")).toContainText("Installed 2.1.1");
    await expect(card(page, "OpenSpec")).toContainText("Propose → Apply → Archive");
    await expect(card(page, "graphify")).toContainText("Installed 0.9.114");
    await expect(card(page, "graphify").getByRole("button", { name: "Update to 0.9.115" })).toBeVisible();
    await expect(card(page, "graphify")).toContainText("graphifyy 0.9.115");
    const gstack = card(page, "gstack");
    await expect(gstack).toContainText("Unverified");
    await expect(gstack).toContainText("Can't be installed: gstack installs into your home folder (~/.claude/skills)");
    await expect(gstack.getByRole("button", { name: "Install" })).toHaveCount(0);
  });

  test("update: read the plan (exact package, hashes, where files go), confirm, watch the log, roll back", async ({ page }) => {
    await page.goto(`${M}/connections`);
    await ready(page);
    await card(page, "graphify").getByRole("button", { name: "Update to 0.9.115" }).click();
    const dialog = page.getByRole("dialog", { name: "Install graphify" });
    await expect(dialog).toContainText("Nothing happens until you confirm");
    await expect(dialog).toContainText("Updating from 0.9.114. The current version is kept for rollback.");
    await expect(dialog).toContainText("graphifyy");
    await expect(dialog).toContainText("Not to be confused with graphify");
    await expect(dialog).toContainText("30 more, each pinned and hashed in the lock");
    await expect(dialog).toContainText("(no network) pip install --no-index --require-hashes");
    await expect(dialog).toContainText("~/.switchboard/packs/graphify/0.9.115");
    await expect(dialog).toContainText("graphify-out/**");
    await expect(dialog).toContainText("python >=3.11.5,<3.15: found 3.12.3");
    await expect(dialog).toContainText("No sudo, no changes to your global npm or Python, nothing in ~/.claude or ~/.codex.");
    await axe(page, '[role="dialog"]');
    await dialog.getByRole("button", { name: "Install graphify" }).click();
    await expect(dialog).toContainText("graphify 0.9.115 installed", { timeout: 15_000 });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(card(page, "graphify")).toContainText("Installed 0.9.115");
    await card(page, "graphify").getByRole("button", { name: "Check files" }).click();
    await expect(card(page, "graphify")).toContainText("Unchanged since it was installed (3445 files, 196 ms)");
    await card(page, "graphify").getByRole("button", { name: "Roll back to 0.9.114" }).click();
    await expect(card(page, "graphify")).toContainText("Installed 0.9.114");
  });
});

test.describe("projects", () => {
  test("turn a pack on for a project, pick its agents, set graphify's mode; savings per group", async ({ page }) => {
    await page.goto(`${M}/settings/projects`);
    await ready(page);
    const notes = page.getByRole("listitem").filter({ hasText: "notes-app" });
    // The mutating server keeps state between runs: toggle from whatever is there.
    const sw = notes.getByRole("switch", { name: "Use OpenSpec in this project" });
    const was = (await sw.getAttribute("aria-checked")) === "true";
    await sw.click();
    await expect(page.getByText("Packs saved").first()).toBeVisible();
    await expect(sw).toHaveAttribute("aria-checked", String(!was));
    const codex = notes.getByRole("checkbox", { name: "Codex" }).first();
    const had = await codex.isChecked();
    await codex.setChecked(!had);
    await expect(codex).toBeChecked({ checked: !had });
    const maths = page.getByRole("listitem").filter({ hasText: "mathutils" });
    await expect(maths).toContainText("Claude Code, plain jobs:Saves 23% tokens (rechecks in 12 jobs)");
    await expect(maths).toContainText("Measuring (2 of 5)");
    await maths.getByRole("radio", { name: "Always" }).check();
    await expect(maths).toContainText("Built for every agent job here");
    await axe(page);
  });
});

test.describe("workflow jobs", () => {
  test("New job with OpenSpec: a review after each step, then the changes", async ({ page }) => {
    // Its own server: a new job waiting for review would change the "need you" count the M4b tests watch.
    await page.goto(`${urls.settings}/jobs`);
    await ready(page);
    await page.getByRole("button", { name: "New job" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task").fill("Add multiply(a, b)");
    const wf = dialog.getByLabel("Workflow");
    await expect(wf).toBeVisible();
    await wf.selectOption({ label: "OpenSpec: propose → apply → archive" });
    await expect(dialog).toContainText("Propose → Apply → Archive. You review each step before the next.");
    await axe(page, '[role="dialog"]');
    await dialog.getByRole("button", { name: /Review/ }).click();
    await dialog.getByRole("button", { name: /Start/ }).click();
    await page.waitForURL(/\/jobs\/\d+$/);
    await expect(page.getByRole("heading", { name: "Review this step" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("finished Propose (step 1 of 3)");
    await expect(page.getByRole("region", { name: "Packs" })).toContainText("Step 1 of 3: Propose");
    await page.getByRole("button", { name: "Approve and go on" }).click();
    await expect(page.getByRole("main")).toContainText("finished Apply (step 2 of 3)");
    await page.getByRole("button", { name: "Approve and go on" }).click();
    await expect(page.getByRole("heading", { name: "Review the changes" })).toBeVisible();
  });

  test("a pack's setup edits are listed apart and unticked by default", async ({ page }) => {
    await page.goto("/jobs/28");
    await ready(page);
    await expect(page.getByRole("main")).toContainText("Changes made by a pack's setup are left out unless you tick them in Changes: 1.");
    const panel = page.getByRole("region", { name: "Packs" });
    await expect(panel).toContainText("OpenSpec: propose → apply → archive");
    await expect(panel).toContainText("Code graph built (1284 nodes)");
    await expect(panel).toContainText("Other changes, left out unless you tick them: 1");
    const setup = page.getByRole("region", { name: "Changed by graphify setup" });
    await expect(setup).toContainText("They are left out of the commit unless you tick them");
    const box = setup.getByRole("checkbox", { name: /AGENTS\.md/ });
    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    await axe(page);
  });
});

test.describe("metrics", () => {
  test("Metrics Pro: graphify's measuring per project, agent and workflow", async ({ page }) => {
    await inPro(page);
    await page.goto("/metrics");
    await ready(page);
    const panel = page.getByRole("region", { name: "Code graph (graphify)" }).first();
    await expect(panel).toContainText("One job in 5 runs without it until each side has 5 jobs");
    await expect(panel).toContainText("Saves 23% tokens (rechecks in 12 jobs)");
    await expect(panel).toContainText("Measuring (2 of 5)");
    await expect(panel).toContainText("61k");
    await expect(panel).toContainText("12 / 5");
  });
});

test.describe("data export", () => {
  test("warns when private chats and attachments are both included", async ({ page }) => {
    await page.goto(`${urls.settings}/settings#data`);
    await ready(page);
    const warning = page.getByTestId("export-secrets-warning");
    await expect(warning).toHaveCount(0);
    await page.getByRole("switch", { name: "Include private chats" }).click();
    await expect(warning).toHaveCount(0);
    await page.getByRole("switch", { name: "Include attachments (.zip)" }).click();
    await expect(warning).toContainText("masked in the chat, but not in the exported file");
    await page.getByRole("switch", { name: "Include private chats" }).click();
    await expect(warning).toHaveCount(0);
  });
});
