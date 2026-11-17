import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ready } from "./helpers";

const schemes = ["light", "dark"] as const;
const pages = ["/", "/dev/components", "/chat", "/settings", "/connections", "/welcome?step=1", "/welcome?step=2", "/welcome?step=3", "/welcome?step=4", "/welcome?step=5"];

/** `scope`: audit only this part of the page (a modal: the page behind it is inert and dimmed on purpose). */
async function audit(page: Page, label: string, scope?: string) {
  const builder = new AxeBuilder({ page });
  if (scope) builder.include(scope);
  const results = await builder
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const minor = results.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical");
  if (minor.length) console.log(`${label}: minor/moderate`, minor.map((v) => `${v.id}(${v.nodes.length})`).join(", "));
  expect(bad, `${label}\n` + bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`).join("\n")).toEqual([]);
}

for (const scheme of schemes) {
  test.describe(`axe · ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const path of pages) {
      test(`${path}`, async ({ page }) => {
        await page.goto(path);
        await ready(page);
        await audit(page, `${path} ${scheme}`);
      });
    }

    test("home · Pro mode, compact density, solid surfaces", async ({ page }) => {
      await page.goto("/?mode=pro&density=compact&solid=1");
      await ready(page);
      await audit(page, `home variants ${scheme}`);
    });

    test("home · sky image", async ({ page }) => {
      await page.goto("/?sky=image");
      await ready(page);
      await audit(page, `home sky-image ${scheme}`);
    });

    test("command palette open", async ({ page }) => {
      await page.goto("/");
      await ready(page);
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit(page, `palette ${scheme}`);
    });

    test("connections · key form open", async ({ page }) => {
      await page.goto("/connections");
      await ready(page);
      await page.getByRole("article", { name: "Cerebras" }).getByRole("button", { name: "Add key" }).click();
      await expect(page.getByLabel("Cerebras API key")).toBeVisible();
      await audit(page, `key form ${scheme}`);
    });

    test("connections · install review dialog open", async ({ page }) => {
      await page.goto("/connections");
      await ready(page);
      await page.getByRole("article", { name: "Grok Build" }).getByRole("button", { name: "Install" }).click();
      await expect(page.getByRole("dialog").getByText("Never uses sudo.")).toBeVisible();
      await audit(page, `install dialog ${scheme}`, '[role="dialog"]');
    });

    test("appearance menu and explain popover open", async ({ page }) => {
      await page.goto("/dev/components");
      await ready(page);
      await page.getByRole("button", { name: "Appearance" }).click();
      await audit(page, `appearance ${scheme}`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Explain Fallbacks/ }).first().click();
      await audit(page, `explain ${scheme}`);
    });
  });
}

test("mobile viewport has no serious issues", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await ready(page);
  await audit(page, "mobile home");
});
