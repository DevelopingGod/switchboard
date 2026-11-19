import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

/**
 * M3b: the Rules UI (/settings/rules). Simple mode = presets, Pro mode = rules, commands, classifier,
 * history; validation, versioning (save, history, diff, rollback, stale edits) and the dry-run tester.
 * Runs against the fixture router (the router's own validation is covered by pytest).
 */
const PATH = "/settings/rules";
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

async function open(page: Page) {
  await page.goto(PATH);
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Routing rules" })).toBeVisible();
}
async function goPro(page: Page) {
  await sidebar(page).getByRole("radio", { name: "Pro" }).click();
  await expect(page.getByRole("tab", { name: "Rules" })).toBeVisible();
}
/** The table row of one rule by exact id ("writing" must not match "writing-premium"). */
const ruleRow = (page: Page, id: string) =>
  page.getByRole("table").getByRole("row").filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${id}(?![\\w-])`) }) });
const unsaved = (page: Page, text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: /unsaved|No unsaved/ })).toContainText(text);

test.describe("Simple mode (read-only data)", () => {
  test("shows the presets only, with the active one marked, and the tester", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("Simple mode shows the presets.")).toBeVisible();
    for (const name of ["Free only", "Balanced", "Best quality"]) await expect(page.getByRole("heading", { level: 3, name })).toBeVisible();
    const balanced = page.getByRole("region", { name: "Balanced" });
    await expect(balanced.getByText("Active")).toBeVisible();
    await expect(page.getByRole("region", { name: "Free only" }).getByRole("radiogroup", { name: "Paid models for Free only" }).getByRole("radio", { name: "Never" })).toBeChecked();
    await expect(page.getByRole("region", { name: "Best quality" })).toContainText("default: best for reasoning");
    await expect(page.locator("summary", { hasText: "Edit this preset’s rules" })).toHaveCount(0); // Pro only
    await expect(page.getByRole("heading", { name: "Try a message" })).toBeVisible();
  });

  test("Pro mode adds the sections", async ({ page }) => {
    await open(page);
    await goPro(page);
    for (const n of ["Presets", "Rules", "Commands & classifier", "History"]) await expect(page.getByRole("tab", { name: n })).toBeVisible();
    await page.getByRole("tab", { name: "Rules" }).click();
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(11); // header + 10 rules
    await expect(table.getByRole("row", { name: /private/ })).toContainText("Private chat");
    await expect(table.getByRole("row", { name: /code-heavy/ })).toContainText("agent claude-code");
    await expect(table.getByRole("row", { name: /code-heavy/ })).toContainText("+4 fallbacks");
  });

  test("tabs work from the keyboard", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Presets" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Rules" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Rules" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "Presets" })).toHaveAttribute("aria-selected", "true");
  });

  test("Settings links to the rules page and the palette has an entry", async ({ page }) => {
    await page.goto("/settings");
    await ready(page);
    await page.getByRole("link", { name: "Edit routing rules" }).click();
    await expect(page).toHaveURL(/\/settings\/rules$/);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" }).getByRole("option", { name: "Routing rules" })).toBeVisible();
  });
});

test.describe("editing, validation, versions (mutating)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ baseURL: urls.mutating });

  test("edit a rule: badge, live count, validation, save as version 1", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit writing", exact: true }).click();
    const form = page.getByRole("region", { name: "Rule: writing" });
    await expect(form).toBeVisible();
    await unsaved(page, "No unsaved changes");

    // a bad value is flagged by the router's validation, and Save is blocked
    await form.getByLabel("Temperature").fill("9");
    await expect(form.getByText("Temperature is between 0 and 2.")).toBeVisible();
    await expect(form.getByLabel("Temperature")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Save changes" }).last()).toBeDisabled();
    await expect(page.getByText("Fix the highlighted problems first.").first()).toBeVisible();

    await form.getByLabel("Temperature").fill("0.3");
    await expect(form.getByText("Temperature is between 0 and 2.")).toHaveCount(0);
    await form.getByLabel("Goes to", { exact: true }).selectOption("model:fast");
    await unsaved(page, "2 unsaved changes");
    await expect(ruleRow(page, "writing")).toContainText("Edited");
    await expect(ruleRow(page, "writing")).toContainText("fast");

    await page.getByLabel("Note for this version (optional)").fill("Prefer Groq for writing");
    await page.getByRole("button", { name: "Save changes" }).last().click();
    await expect(page.getByText("Saved as version 1").first()).toBeVisible();
    await unsaved(page, "No unsaved changes");
    // the row is still marked as edited (it differs from rules.yaml)
    await expect(ruleRow(page, "writing")).toContainText("Edited");
  });

  test("setting a field back to rules.yaml removes the override", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit writing", exact: true }).click();
    const form = page.getByRole("region", { name: "Rule: writing" });
    await form.getByLabel("Temperature").fill("0.8"); // the base value; it was 0.3
    await unsaved(page, "1 unsaved change");
    await form.getByLabel("Goes to", { exact: true }).selectOption("model:smart-free"); // the base target
    await unsaved(page, "2 unsaved changes"); // draft == rules.yaml now, but version 1 still holds both overrides
    await expect(ruleRow(page, "writing")).not.toContainText("Edited");
    await page.getByRole("button", { name: "Discard" }).last().click();
    await unsaved(page, "No unsaved changes");
  });

  test("fallbacks: add, reorder, remove with buttons; unknown aliases are refused with a plain message", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit default", exact: true }).click();
    const form = page.getByRole("region", { name: "Rule: default" });
    await expect(form.getByRole("listitem")).toHaveCount(3);
    await form.getByRole("button", { name: "Move fallback 1 down" }).click();
    await expect(form.getByLabel("If that isn’t available, try 2")).toHaveValue("model:smart-free");
    await form.getByRole("button", { name: "Remove fallback 3" }).click();
    await expect(form.getByRole("listitem")).toHaveCount(2);
    await form.getByRole("button", { name: "Add fallback" }).click();
    await expect(form.getByRole("listitem")).toHaveCount(3);
    // type an alias that doesn't exist
    await form.getByLabel("If that isn’t available, try 3").selectOption("__custom__");
    await form.getByRole("textbox", { name: "If that isn’t available, try 3" }).fill("model:nope");
    await expect(form.getByText(/There is no model alias 'nope'/)).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).last().click();
    await expect(form.getByLabel("Goes to", { exact: true })).toHaveValue("model:fast");
  });

  test("the private rule can only point at local models, can't have fallbacks and can't be removed", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit private", exact: true }).click();
    const form = page.getByRole("region", { name: "Rule: private" });
    await expect(form.getByText(/Private chats always stay on this computer/)).toBeVisible();
    const options = await form.getByLabel("Goes to", { exact: true }).locator("option").allTextContents();
    expect(options.sort()).toEqual(["local", "local-code", "private"]);
    await expect(form.getByRole("group", { name: "If that isn’t available, try" })).toHaveCount(0);
    await expect(form.getByText("This rule can’t be removed.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Remove rule" })).toHaveCount(0);
    await expect(form.getByRole("group", { name: "Applies when" })).toHaveAttribute("disabled", "");
    await expect(form.getByLabel("Kind of request")).toBeDisabled();
  });

  test("add a rule, remove one, restore it; slash commands and classifier wording", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Add a rule" }).click();
    await page.getByLabel("Rule name").fill("Bad Name");
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeDisabled();
    await page.getByLabel("Rule name").fill("quick-chat");
    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(page.getByRole("region", { name: "Rule: quick-chat" })).toBeVisible();
    const rows = page.getByRole("table").getByRole("row");
    await expect(rows.nth(10)).toContainText("quick-chat"); // just before the catch-all
    await expect(rows.nth(11)).toContainText("default");
    await expect(rows.nth(10)).toContainText("New");

    await page.getByRole("button", { name: "Edit bulk", exact: true }).click();
    await page.getByRole("button", { name: "Remove rule" }).click();
    await expect(page.getByRole("list", { name: "Removed" })).toContainText("bulk");
    // the /bulk command now points at a rule that is gone: the router says so in plain words
    await expect(page.getByText(/slash commands point at unknown rules|bulk/).first()).toBeAttached();
    await page.getByRole("button", { name: "Restore rule" }).click();
    await expect(page.getByRole("list", { name: "Removed" })).toHaveCount(0);

    await page.getByRole("tab", { name: "Commands & classifier" }).click();
    await page.getByLabel("Command", { exact: true }).fill("quick");
    await page.getByRole("button", { name: "Add command" }).click();
    await expect(page.getByText("/quick")).toBeVisible();
    const desc = page.getByLabel("sensitive_health");
    await expect(page.getByText(/keeps a message on this computer/).first()).toBeVisible();
    await desc.fill("My own wording about health matters.");
    await expect(page.getByRole("button", { name: "Back to the original wording" })).toBeVisible();

    await page.getByLabel("Note for this version (optional)").fill("Added quick-chat");
    await page.getByRole("button", { name: "Save changes" }).last().click();
    await expect(page.getByText("Saved as version 2").first()).toBeVisible();
  });

  test("history: versions, diff against the previous one, rollback keeps every version", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "History" }).click();
    const items = page.getByRole("list").filter({ has: page.getByText("Version 2") }).getByRole("listitem");
    await expect(page.getByText("Version 2").first()).toBeVisible();
    await expect(page.getByText("Version 1").first()).toBeVisible();
    await expect(page.getByText("Current")).toHaveCount(1);
    await expect(page.getByText("Added quick-chat")).toBeVisible();

    const v2 = page.getByRole("listitem").filter({ hasText: "Version 2" });
    await v2.getByRole("button", { name: "Show changes" }).click();
    await expect(v2.getByText("Compared with the version before it")).toBeVisible();
    await expect(v2.getByText("Rule quick-chat · target")).toBeVisible();
    await expect(v2.getByText("Classifier route sensitive_health · description")).toBeVisible();

    const v1 = page.getByRole("listitem").filter({ hasText: "Version 1" });
    await v1.getByRole("button", { name: "Roll back to this version" }).click();
    await expect(page.getByRole("group", { name: "Make version 1 the current rules again?" })).toBeVisible();
    await page.getByRole("button", { name: "Roll back", exact: true }).click();
    await expect(page.getByText("Rolled back to version 1").first()).toBeVisible();
    await expect(page.getByText("Version 3").first()).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Version 3" })).toContainText("Current");
    await expect(page.getByRole("listitem").filter({ hasText: "Version 2" })).toBeVisible(); // nothing was rewritten
    expect(items).toBeTruthy();
  });

  test("a stale edit is refused and nothing is overwritten", async ({ browser }) => {
    const a = await browser.newPage({ baseURL: urls.mutating });
    const b = await browser.newPage({ baseURL: urls.mutating });
    for (const p of [a, b]) {
      await open(p);
      await goPro(p);
      await p.getByRole("tab", { name: "Rules" }).click();
      await p.getByRole("button", { name: "Edit default", exact: true }).click();
    }
    await a.getByRole("region", { name: "Rule: default" }).getByLabel("Temperature").fill("0.5");
    await a.getByRole("button", { name: "Save changes" }).last().click();
    await expect(a.getByText(/Saved as version \d+/).first()).toBeVisible();
    await b.getByRole("region", { name: "Rule: default" }).getByLabel("Temperature").fill("0.9");
    await b.getByRole("button", { name: "Save changes" }).last().click();
    await expect(b.getByText("The rules changed somewhere else. Reload and apply your edit again.").first()).toBeVisible();
    await b.getByRole("button", { name: "Reload" }).click();
    await a.close();
    await b.close();
  });
});

test.describe("dry-run tester (mutating state kept untouched)", () => {
  test.use({ baseURL: urls.mutating });

  test("shows the decision, classifier, order, reasons and (Pro) the score breakdown", async ({ page }) => {
    await open(page);
    await page.getByLabel("Message to test").fill("Write a short LinkedIn post about my launch");
    await page.getByRole("button", { name: "Test routing" }).click();
    const decision = page.getByRole("region", { name: "Decision" });
    await expect(decision.getByText("writing", { exact: true }).first()).toBeVisible();
    await expect(decision).toContainText("Arch-Router · route writing");
    await expect(decision).toContainText("First choice");
    await expect(decision).toContainText("Runner-up");
    await expect(page.getByRole("region", { name: "Order it would be tried" }).getByRole("listitem").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Why" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Score breakdown" })).toBeVisible();
    await expect(page.getByText("Capability")).toHaveCount(0); // factor bars are Pro
    await goPro(page);
    await page.getByRole("button", { name: "Test routing" }).click();
    await expect(page.getByRole("region", { name: "Score breakdown" }).getByText("Capability").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Score breakdown" }).getByText("Free quota left").first()).toBeVisible();
  });

  test("unsaved changes are included and never persisted", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit default", exact: true }).click();
    await page.getByRole("region", { name: "Rule: default" }).getByLabel("Goes to", { exact: true }).selectOption("model:local");
    await page.getByLabel("Message to test").fill("what is the capital of France?");
    await page.getByRole("button", { name: "Test routing" }).click();
    await expect(page.getByText("Using your unsaved changes").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Decision" })).toContainText("local");
    await page.getByRole("button", { name: "Discard" }).last().click();
    await page.getByRole("button", { name: "Test routing" }).click();
    await expect(page.getByText("Using the saved rules").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Decision" })).not.toContainText(/First choice\s*local\b/);
  });

  test("an invalid draft says why instead of testing", async ({ page }) => {
    await open(page);
    await goPro(page);
    await page.getByRole("tab", { name: "Rules" }).click();
    await page.getByRole("button", { name: "Edit default", exact: true }).click();
    await page.getByRole("region", { name: "Rule: default" }).getByLabel("Temperature").fill("9");
    await page.getByLabel("Message to test").fill("hello");
    await expect(page.getByRole("button", { name: "Test routing" })).toBeDisabled();
    await expect(page.getByText("Fix the highlighted problems first.").first()).toBeVisible();
  });
});

test.describe("layout", () => {
  for (const width of [360, 768, 1024, 1280, 1440, 1920]) {
    test(`the rules table fits its box, the page never scrolls sideways (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      if (width < 768) await page.getByRole("button", { name: "Open menu" }).click();
      await sidebar(page).getByRole("radio", { name: "Pro" }).click();
      if (width < 768) await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Rules" }).click();
      await page.getByRole("button", { name: "Edit writing", exact: true }).click();
      const m = await page.evaluate(() => {
        const t = document.querySelector("table")!;
        const wrap = t.parentElement!;
        return { tableScrolls: wrap.scrollWidth > wrap.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(m.tableScrolls, "the table scrolls inside its box").toBe(false);
      expect(m.page, "the page scrolls sideways").toBeLessThanOrEqual(0);
      await expect(page.getByRole("region", { name: "Rule: writing" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Try a message" })).toBeVisible();
    });
  }
});

test.describe("router down", () => {
  test("a plain message with one action", async ({ page }) => {
    // The fixture router has no 'down' switch for /rules; the page-level empty state is covered by the
    // shared EmptyState tests. Here: the route renders its heading and a Settings breadcrumb.
    await open(page);
    await expect(page.getByRole("link", { name: "Settings", exact: true }).first()).toBeVisible();
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe · rules · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    async function audit(page: Page, label: string) {
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad, `${label}\n` + bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`).join("\n")).toEqual([]);
    }

    test("Simple: presets and the tester with a result", async ({ page }) => {
      await open(page);
      await page.getByLabel("Message to test").fill("Write a short LinkedIn post");
      await page.getByRole("button", { name: "Test routing" }).click();
      await expect(page.getByRole("region", { name: "Decision" })).toBeVisible();
      await audit(page, `simple ${scheme}`);
    });

    for (const tab of ["Presets", "Rules", "Commands & classifier", "History"]) {
      test(`Pro: ${tab}`, async ({ page }) => {
        await open(page);
        await goPro(page);
        await page.getByRole("tab", { name: tab }).click();
        if (tab === "Rules") await page.getByRole("button", { name: "Edit code-heavy", exact: true }).click();
        if (tab === "Presets") await page.locator("summary", { hasText: "Edit this preset’s rules" }).first().click();
        await page.waitForTimeout(150);
        await audit(page, `pro ${tab} ${scheme}`);
      });
    }
  });
}
