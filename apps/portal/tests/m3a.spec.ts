import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

/**
 * M3a UI: auto-private note + "Not sensitive — use cloud", the masked-secret note, the long-thread
 * summary note, Status reasons, Settings (auto-detect, explore, local models), Home honouring
 * "Start new chats as Private", and the wizard's detected-GPU line. Fixture scenarios are chosen by
 * prompt text (src/lib/server/chat-fixtures.ts).
 */
const HEALTH = "6f1c2a10-0000-4000-8000-000000000003"; // auto-private, with a summary
const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789"; // fixture only

const lastReply = (page: Page) => page.getByRole("article", { name: "Assistant" }).last();

async function send(page: Page, text: string) {
  const box = page.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

test.describe("chat · privacy notes", () => {
  test.use({ baseURL: urls.mutating });

  test("a sensitive message stays local with a notice; one click sends it to the cloud", async ({ page }) => {
    await page.goto("/chat");
    await ready(page);
    await send(page, "My blood test shows high ALT, what does it mean?");
    const reply = lastReply(page);
    await expect(reply.getByText("Kept local: this looks sensitive (health).")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Private" })).toHaveAttribute("aria-checked", "true");
    await reply.getByRole("button", { name: "Not sensitive — use cloud" }).click();
    const again = lastReply(page);
    await expect(again.getByRole("button", { name: /Why this\? Routed to Groq · gpt-oss-120b/ })).toBeVisible();
    await expect(again.getByText(/Kept local/)).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Private" })).toHaveAttribute("aria-checked", "false");
  });

  test("a pasted secret is masked, kept local, with no override", async ({ page }) => {
    await page.goto("/chat");
    await ready(page);
    await send(page, `why does ${KEY} return 401?`);
    // masked in the message and in the words title alike
    await expect(page.getByText("why does [secret masked: API key] return 401?")).toBeVisible();
    await expect(page.getByText("Looks like you pasted a secret — kept local and masked. Consider rotating it.")).toBeVisible();
    await expect(lastReply(page).getByText("Kept local: your message had a secret in it, so this chat stays on this machine.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Not sensitive — use cloud" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(KEY);
  });
});

test.describe("chat · long-thread summary", () => {
  test("the summary note sits where it takes over, collapsed, and passes axe", async ({ page }) => {
    await page.goto(`${urls.main}/chat?t=${HEALTH}`);
    await ready(page);
    const toggle = page.getByRole("button", { name: "Summary of earlier messages" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page.getByText("Covers 2 earlier messages.", { exact: false })).toBeVisible();
    await expect(page.getByText(/doctor wants a re-test in 6 weeks/)).toBeVisible();
    // the sensitive note on the older reply has no button (it isn't the last reply)
    await expect(page.getByText("Kept local: this looks sensitive (health).")).toBeVisible();
    await expect(page.getByRole("button", { name: "Not sensitive — use cloud" })).toHaveCount(0);
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});

test.describe("status · specific reasons", () => {
  test("rate limits with an end time, quota use, classifier and local profile", async ({ page }) => {
    await page.goto(`${urls.main}/status`);
    await ready(page);
    await expect(page.getByText(/^Rate-limited until \d{1,2}:\d{2}/)).toBeVisible();
    await expect(page.getByText(/^82% of today’s free limit used\. Resets at/)).toBeVisible();
    await expect(page.getByText("Arch-Router is reading each message to pick the right rule.")).toBeVisible();
    await expect(page.getByText("Detected 4 GB → profile “4–6 GB GPU”. Its models are pulled.")).toBeVisible();
    await expect(page.getByText(/until \./)).toHaveCount(0); // no empty times
  });
});

// Settings + Home tests for M3a live in m15-settings.spec.ts: they share its serial settings server.

test.describe("wizard (M3a)", () => {
  test("the Connect step says which local profile the GPU got", async ({ page }) => {
    await page.goto(`${urls.mutating}/welcome?step=2`);
    await ready(page);
    await page.getByLabel("Private work").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/Detected 4 GB GPU → local profile “4–6 GB GPU” \(Arch-Router \+ qwen3:4b\)/)).toBeVisible();
  });
});
