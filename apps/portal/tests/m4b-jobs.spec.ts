import { test, expect, type Page } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

/**
 * M4b: the Jobs board, job detail (timeline, live log, plan, diff, decisions, merge help), Run as job,
 * the agent fleet, Settings → Projects and → Jobs, and the sidebar badge. Read-only checks use the main
 * fixture server; anything that changes fixture state runs serially on the mutating server.
 */

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

test.describe("read-only", () => {
  test("board: status tabs with counts, filters in the URL, paging", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Status" });
    await expect(tabs.getByRole("link", { name: /All\s*30/ })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: /Needs you\s*2/ })).toBeVisible();
    const region = page.getByRole("region", { name: "Jobs" });
    const list = region.getByRole("list", { name: "Jobs" });
    await expect(list.getByRole("listitem")).toHaveCount(25);
    await expect(region.getByText("25 of 30")).toBeVisible();
    await region.getByRole("button", { name: "Load more" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(30);
    await expect(region.getByRole("button", { name: "Load more" })).toHaveCount(0);

    await tabs.getByRole("link", { name: /Needs you/ }).click();
    await expect(page).toHaveURL(/status=needs_approval/);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByText("Approve the plan")).toBeVisible();
    await expect(list.getByText("Review the changes")).toBeVisible();

    await page.goto("/jobs");
    await page.getByLabel("Agent").selectOption("codex");
    await expect(page).toHaveURL(/agent=codex/);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(tabs.getByRole("link", { name: /All\s*2/ })).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/jobs$/);
  });

  test("detail: plan to approve, timeline in words, expiry, merge help, cost", async ({ page }) => {
    await page.goto("/jobs/30");
    await ready(page);
    const gate = page.getByRole("region", { name: "Approve the plan" });
    await expect(gate).toContainText("Claude Code wrote this plan without changing anything");
    await expect(gate).toContainText("the job stops (Settings → Jobs)");
    await expect(gate.getByRole("button", { name: "Approve plan" })).toBeEnabled();
    await expect(gate.getByRole("button", { name: "Reject" })).toBeEnabled();
    await expect(page.getByRole("tabpanel")).toContainText("Add `multiply(a, b)`".replace(/`/g, ""));
    await page.getByRole("tab", { name: "Timeline" }).click();
    const tl = page.getByRole("list", { name: "What happened" });
    await expect(tl).toContainText("Job created for claude-code, opencode at autonomy 1.");
    await expect(tl).toContainText("Made a copy on branch switchboard/job-30.");
    await expect(tl).toContainText("Waiting for you: plan.");
    // keyboard: arrows move between tabs
    await page.getByRole("tab", { name: "Timeline" }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Live log" })).toBeFocused();

    await expect(page.getByText("$0.05 of $2.00 list price")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy branch name" })).toBeVisible();
    const merge = page.getByRole("region", { name: "Review and merge it yourself" });
    await expect(merge).toContainText("Switchboard never pushes");
    await expect(merge).toContainText("git merge --no-ff switchboard/job-30");
    await expect(page.getByRole("link", { name: "Open in Paperclip" })).toHaveCount(0); // no issue id in the fixture
  });

  test("detail: the diff per file, expand and collapse, cost not reported", async ({ page }) => {
    await page.goto("/jobs/28");
    await ready(page);
    await expect(page.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    const diff = page.getByRole("region", { name: "Changes", exact: true });
    await expect(diff).toContainText("3 files changed");
    await expect(diff.getByText("mathutils.py", { exact: true })).toBeVisible();
    await expect(diff.locator('[aria-label="mathutils.py"]')).toContainText("def multiply(a, b):");
    await expect(diff.locator('[aria-label="CHANGELOG.md"]')).toHaveCount(0); // only the first file starts open
    await diff.getByRole("button", { name: "Collapse all" }).click();
    await expect(diff.locator('[aria-label="mathutils.py"]')).toHaveCount(0);
    await diff.getByRole("button", { name: "Expand all" }).click();
    await expect(diff.locator('[aria-label="CHANGELOG.md"]')).toContainText("# Changelog");
    await expect(page.getByRole("button", { name: "Approve and commit" })).toBeVisible();

    await page.goto("/jobs/26");
    await ready(page);
    await expect(page.getByText("Cost not reported", { exact: true })).toBeVisible();
    await expect(page.getByText(/doesn’t report what a run would cost/)).toBeVisible();
  });

  test("detail: the live log streams (SSE) and resumes without repeating lines", async ({ page }) => {
    await page.goto("/jobs/27");
    await ready(page);
    const log = page.getByRole("log", { name: "Live log" });
    await expect(log).toContainText("Done: multiply added with a test; 2 tests pass.");
    await expect(log.getByText("$ python3 -m unittest")).toHaveCount(1);
    // The proxy passes Last-Event-ID on, so a reconnect resumes after the last line it saw. The stream stays
    // open for a running job, so read what arrives for a moment.
    const body = await page.evaluate(async () => {
      const ctl = new AbortController();
      const r = await fetch("/api/jobs/27/events", { headers: { "Last-Event-ID": "log:run-27-1:5" }, signal: ctl.signal });
      const reader = r.body!.getReader();
      let text = "";
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        const { value, done } = await Promise.race([reader.read(), new Promise<{ value?: Uint8Array; done: boolean }>((ok) => setTimeout(() => ok({ done: false }), 300))]);
        if (done) break;
        if (value) text += new TextDecoder().decode(value);
      }
      ctl.abort();
      return text;
    });
    expect(body).toContain("Done: multiply added");
    expect(body).not.toContain("Reading mathutils.py"); // line 2: before the resume point
    // A finished job shows its last run's output from the paged log.
    await page.goto("/jobs/25");
    await ready(page);
    await page.getByRole("tab", { name: "Live log" }).click();
    await expect(page.getByRole("log", { name: "Live log" })).toContainText("Ran 2 tests");
    await expect(page.getByLabel("Run")).toHaveValue("run-25-1");
  });

  test("the event stream refuses cross-site and non-loopback requests", async ({ request }) => {
    const cross = await request.get("/api/jobs/27/events", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status()).toBe(403);
    const host = await request.get("/api/jobs/27/events", { headers: { Host: "evil.example" } });
    expect(host.status()).toBe(403);
    const bad = await request.get("/api/jobs/abc/events");
    expect(bad.status()).toBe(404);
    const attention = await request.get("/api/jobs/attention", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(attention.status()).toBe(403);
  });

  test("fleet: status, success, budgets, levels with reasons, hire dialog", async ({ page }) => {
    await page.goto("/jobs/agents");
    await ready(page);
    const fleet = page.getByRole("region", { name: "Agents" });
    const claude = fleet.getByRole("article", { name: "Claude Code" });
    await expect(claude).toContainText("Working");
    await expect(claude).toContainText("88% of 8");
    await expect(claude.getByRole("link", { name: /Now: Add input validation/ })).toHaveAttribute("href", "/jobs/27");
    await claude.getByText("Can run").click();
    await expect(claude).toContainText("Level 3: Level 3 is off");
    await expect(fleet.getByRole("article", { name: "Codex" })).toContainText("Cost not reported");
    await expect(fleet.getByRole("article", { name: "Reviewer" })).toContainText("Paused");
    await expect(fleet.getByRole("article", { name: "Reviewer" }).getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(claude.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(fleet.getByRole("article", { name: "Gemini CLI" })).toContainText("Not verified for jobs yet");

    await page.getByRole("button", { name: "Hire agent" }).click();
    const dlg = page.getByRole("dialog", { name: "Hire an agent" });
    await expect(dlg.getByRole("radio", { name: /Claude Code/ })).toBeChecked();
    await expect(dlg.getByRole("radio", { name: /Gemini CLI/ })).toBeDisabled();
    await expect(dlg).toContainText("Level 3 isn’t available");
    await dlg.getByRole("radio", { name: /^Codex/ }).check();
    await expect(dlg).toContainText("Codex chooses (its own default)");
  });

  test("Settings → Projects lists folders, copies and disk use", async ({ page }) => {
    await page.goto("/settings/projects");
    await ready(page);
    const m = page.getByRole("article", { name: "mathutils" });
    await expect(m).toContainText("/home/you/code/mathutils");
    await expect(m).toContainText(/Copies\s*4 · \d+ KB on disk/);
    await expect(m.getByRole("link", { name: "switchboard/job-30" })).toHaveAttribute("href", "/jobs/30");
    await expect(m).toContainText("(merged)");
    await expect(page.getByRole("region", { name: "Keep finished copies" }).getByRole("textbox")).toHaveValue("10");
  });

  test("sidebar: the Jobs badge says how many jobs need you", async ({ page }) => {
    await page.goto("/connections");
    await ready(page);
    const jobs = sidebar(page).getByRole("link", { name: /^Jobs/ });
    // The watcher loads when the page is idle, then asks once.
    await expect(jobs).toHaveAccessibleName("Jobs 2 need you", { timeout: 20_000 });
    await expect(jobs.locator(".sb-badge")).toHaveText("2 need you"); // "need you" is screen-reader text
  });
});

test.describe("chat → job", () => {
  test("Run as job from a chat reply: proposal, order, level 3 off with its reason, preview, nothing starts", async ({ page }) => {
    // Sending a message adds a chat to the recents, so this runs on the mutating server like the chat tests.
    await page.goto(`${urls.mutating}/chat`);
    await ready(page);
    await page.getByRole("textbox", { name: /Message/ }).fill("Please fix the failing tests in my repo");
    await page.keyboard.press("Enter");
    const run = page.getByRole("button", { name: "Run as job" });
    await expect(run).toBeEnabled({ timeout: 15_000 });
    await run.click();
    const dlg = page.getByRole("dialog", { name: "Run as job" });
    await expect(dlg.getByRole("textbox", { name: "Task" })).toHaveValue("Please fix the failing tests in my repo");
    const agents = dlg.getByRole("group", { name: "Agents, in order" });
    await expect(agents.getByRole("listitem")).toHaveCount(2);
    await expect(agents.getByRole("listitem").first()).toContainText("Claude Code");
    await agents.getByRole("button", { name: "Move OpenCode up" }).click();
    await expect(agents.getByRole("listitem").first()).toContainText("OpenCode");

    const dial = dlg.getByRole("slider", { name: "Autonomy" });
    await expect(dial).toHaveAttribute("aria-valuenow", "1");
    await dial.press("End"); // level 3 can't be chosen: the handle stops at 2
    await expect(dial).toHaveAttribute("aria-valuenow", "2");
    await dial.press("ArrowRight");
    await expect(dial).toHaveAttribute("aria-valuenow", "2");
    await expect(dlg).toContainText("Level 3 isn’t available");
    await dial.press("Home");
    await dial.press("ArrowRight");

    await dlg.getByRole("button", { name: "Review" }).click();
    await expect(dlg.getByRole("heading", { name: "What will happen" })).toBeVisible();
    await expect(dlg).toContainText("OpenCode reads the project and writes a plan");
    await expect(dlg).toContainText("Nothing more happens until you approve the plan");
    await expect(dlg).toContainText("Nothing is pushed.");
    await expect(dlg.getByRole("button", { name: "Start job" })).toBeEnabled();
    await dlg.getByRole("button", { name: "Back" }).click();
    await expect(dlg.getByRole("button", { name: "Review" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
  });
});

test.describe("changes state", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: urls.mutating });

  test("a job that finishes elsewhere raises a toast on another page", async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await browser.newContext({ baseURL: urls.mutating, reducedMotion: "reduce" });
    const watcher = await ctx.newPage();
    await watcher.goto("/jobs/agents");
    await ready(watcher);
    await expect(sidebar(watcher).getByRole("link", { name: "Jobs 2 need you" })).toBeVisible({ timeout: 20_000 }); // baseline taken
    const actor = await ctx.newPage();
    await actor.goto("/jobs/28");
    await ready(actor);
    await actor.getByRole("button", { name: "Approve and commit" }).click();
    await expect(actor.getByRole("status").filter({ hasText: "Approved" })).toBeVisible();
    // The watcher polls every 15 s; the job page itself never announces its own job.
    await expect(watcher.getByText("Job 28 is done")).toBeVisible({ timeout: 30_000 });
    await expect(sidebar(watcher).getByRole("link", { name: "Jobs 1 needs you" })).toBeVisible();
    await ctx.close();
  });

  test("approve a plan; stop a job", async ({ page }) => {
    await page.goto("/jobs/30");
    await ready(page);
    await page.getByRole("textbox", { name: "Note (optional)" }).fill("Keep it small");
    await page.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Approved" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Approve the plan" })).toHaveCount(0);

    await page.goto("/jobs/29");
    await ready(page);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("The branch stays.");
    await page.getByRole("button", { name: "Stop job" }).click();
    await expect(page.getByText("Stopped by you")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run again" })).toBeVisible();
  });

  test("New job: confirm starts it and opens its page", async ({ page }) => {
    await page.goto("/jobs");
    await ready(page);
    await page.getByRole("button", { name: "New job" }).click();
    const dlg = page.getByRole("dialog", { name: "New job" });
    await dlg.getByRole("textbox", { name: "Task" }).fill("Add a function power(a, b) with tests");
    await dlg.getByRole("button", { name: "Review" }).click();
    await dlg.getByRole("button", { name: "Start job" }).click();
    await expect(page).toHaveURL(/\/jobs\/31$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a function power(a, b) with tests");
    await expect(page.getByText("Queued").first()).toBeVisible();
  });

  test("hire, pause and resume, delete an agent", async ({ page }) => {
    await page.goto("/jobs/agents");
    await ready(page);
    await page.getByRole("button", { name: "Hire agent" }).click();
    const dlg = page.getByRole("dialog", { name: "Hire an agent" });
    await dlg.getByRole("textbox", { name: "Name" }).fill("Bug hunter");
    await dlg.getByRole("textbox", { name: "Role" }).fill("You look for bugs.");
    await dlg.getByLabel("Model").selectOption("claude-opus-5-5");
    await dlg.getByRole("button", { name: "Hire", exact: true }).click();
    const card = page.getByRole("article", { name: "Bug hunter" });
    await expect(card).toContainText("You look for bugs.");
    await expect(card).toContainText("claude-opus-5-5");

    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card).toContainText("Paused");
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card).toContainText("Ready");

    await card.getByRole("button", { name: "Delete" }).click();
    await expect(card.getByRole("alertdialog")).toContainText("Its past jobs and costs are kept.");
    await card.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("article", { name: "Bug hunter" })).toHaveCount(0);

    // A name that is taken is refused in plain words
    await page.getByRole("button", { name: "Hire agent" }).click();
    await dlg.getByRole("textbox", { name: "Name" }).fill("Reviewer");
    await dlg.getByRole("button", { name: "Hire", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("already exists");
  });

  test("projects: plain errors, the Switchboard repo refused, add and remove", async ({ page }) => {
    await page.goto("/settings/projects");
    await ready(page);
    const form = page.getByRole("region", { name: "Add a folder" });
    const path = page.getByRole("textbox", { name: "Folder path" });
    const add = page.getByRole("button", { name: "Add a folder" });
    await path.fill("code/myrepo");
    await add.click();
    await expect(form.getByRole("alert")).toContainText("Use the folder's full path");
    await path.fill("~/switchboard");
    await add.click();
    await expect(form.getByRole("alert")).toContainText("That is the Switchboard repository itself");
    await path.fill("/home/you/code/plain-folder");
    await add.click();
    await expect(form.getByRole("alert")).toContainText("isn't a git repository");
    await path.fill("~/code/new-repo");
    await add.click();
    const card = page.getByRole("article", { name: "new-repo" });
    await expect(card).toContainText("/home/you/code/new-repo");
    await card.getByRole("button", { name: "Remove" }).click();
    await card.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("article", { name: "new-repo" })).toHaveCount(0);

    const busy = page.getByRole("article", { name: "notes-app" });
    await busy.getByRole("button", { name: "Remove" }).click();
    await busy.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(busy.getByRole("alert")).toContainText("still active in this project");
  });

  test("Settings → Jobs: approval expiry and desktop notifications (asked only when turned on)", async ({ page, context }) => {
    await context.grantPermissions(["notifications"]);
    await page.goto("/settings#jobs");
    await ready(page);
    const s = page.getByRole("region", { name: "Jobs" });
    const hours = s.getByRole("textbox", { name: /Stop a job that waits/ });
    await expect(hours).toHaveValue("24");
    await hours.fill("800");
    await s.getByRole("button", { name: "Save" }).click();
    await expect(s.getByRole("alert")).toContainText("0 to 720");
    await hours.fill("48");
    await s.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
    const sw = s.getByRole("switch", { name: "Desktop notifications for jobs" });
    await expect(sw).not.toBeChecked();
    await sw.click();
    await expect(sw).toBeChecked();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("switchboard.prefs.v1") ?? "{}").jobNotifications)).toBe(true);
    await expect(s.getByRole("link", { name: "Open Projects" })).toHaveAttribute("href", "/settings/projects");
  });

});
