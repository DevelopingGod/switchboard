import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { urls } from "../playwright.config";
import { inPro, ready } from "./helpers";

/**
 * Chat (M2) against the fixture router. Sending changes fixture state, so these run on the
 * mutating server; read-only checks of the seeded thread use the main server.
 * Scenarios are chosen by prompt text (src/lib/server/chat-fixtures.ts).
 */
const SEED = "6f1c2a10-0000-4000-8000-000000000001";

async function newChat(page: Page) {
  await page.goto(`${urls.mutating}/chat`);
  await ready(page);
}

async function send(page: Page, text: string) {
  const box = page.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
}

const lastReply = (page: Page) => page.getByRole("article", { name: "Assistant" }).last();

// These assert the full breakdown (rule names, runner-up, skipped), which is Pro mode; Simple mode has its own spec (m3b-simple).
test.beforeEach(async ({ page }) => inPro(page));

test.describe("chat · sending", () => {
  test("New chat after a thread was started in place really starts a new one", async ({ page }) => {
    await newChat(page);
    await send(page, "Why is the sky blue?");
    await expect(page).toHaveURL(/\/chat\?t=[0-9a-f-]{36}$/);
    await expect(lastReply(page)).toContainText("Rayleigh scattering");
    await page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "New chat" }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator("main").getByText("Why is the sky blue?")).toHaveCount(0); // (the sidebar may list a chat with that title)
    await expect(page.getByRole("article", { name: "Assistant" })).toHaveCount(0);
    await expect(page.getByLabel("Message")).toHaveValue("");
  });

  test("streams a reply with a route chip, cost and a local title", async ({ page }) => {
    await newChat(page);
    await send(page, "Why is the sky blue?");
    const reply = lastReply(page);
    await expect(reply).toContainText("Rayleigh scattering");
    await expect(reply.getByRole("button", { name: /Why this\? Routed to Groq · gpt-oss-120b by rule default/ })).toBeVisible();
    await expect(reply.getByText("Free", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A quick answer"); // local-model title
    await expect(page.getByRole("region", { name: "Recent chats" }).getByRole("link", { name: "A quick answer" })).toBeVisible();
    await expect(page).toHaveURL(/\/chat\?t=[0-9a-f-]{36}$/);

    await reply.getByRole("button", { name: /Why this\?/ }).click();
    const pop = page.getByRole("dialog", { name: "Why this route?" });
    await expect(pop).toContainText("default");
    await expect(pop).toContainText("General chat → default rule");
    await expect(pop).toContainText("Google AI Studio · gemini-3.1-flash-lite"); // runner-up
    await expect(pop).toContainText("117 in · 81 out");
    await expect(pop).toContainText(/Free \(≈ \$0\.0001 value\)|Free \(≈ < \$0\.0001 value\)/);
  });

  test("a 429 on the primary falls back and the chip says why", async ({ page }) => {
    await newChat(page);
    await send(page, "please hit a rate limit for me");
    const reply = lastReply(page);
    await expect(reply.getByRole("button", { name: /Routed to Google AI Studio/ })).toBeVisible();
    await reply.getByRole("button", { name: /Why this\?/ }).click();
    const pop = page.getByRole("dialog", { name: "Why this route?" });
    await expect(pop).toContainText("Fallback: Groq · gpt-oss-120b skipped (Rate limited (429))");
    await expect(pop.getByText("Rate limited (429)", { exact: false }).first()).toBeVisible();
  });

  test("private stays local: badge, local chip, picker limited to local models", async ({ page }) => {
    await newChat(page);
    const think = page.getByRole("button", { name: "Think harder" });
    await expect(think).toHaveCount(0); // only offered when the answer stays local
    await page.getByRole("switch", { name: "Private" }).click();
    // M4a: the local model answers at once, without a thinking phase…
    await send(page, "my health notes");
    let reply = lastReply(page);
    await expect(reply.getByRole("button", { name: /Routed to Ollama · qwen3:4b-instruct-2507-q4_K_M by rule private/ })).toBeVisible();
    await expect(reply.getByRole("button", { name: /Thought for/ })).toHaveCount(0);
    // …and "Think harder" asks the thinking model, for that one message only.
    await expect(think).toHaveAttribute("aria-pressed", "false");
    await think.click();
    await expect(think).toHaveAttribute("aria-pressed", "true");
    const sent = page.waitForRequest((r) => r.url().endsWith("/api/chat/stream"));
    await send(page, "my health notes, think it through");
    expect((await sent).postDataJSON()).toMatchObject({ private: true, think: true });
    await expect(think).toHaveAttribute("aria-pressed", "false");
    reply = lastReply(page);
    await expect(reply.getByRole("button", { name: /Routed to Ollama · qwen3:4b by rule private/ })).toBeVisible();
    await expect(page.getByText("Private: stays on this computer")).toBeVisible();
    // Thinking streamed live, collapsed by default, never saved.
    const thought = reply.getByRole("button", { name: /Thought for/ });
    await expect(thought).toHaveAttribute("aria-expanded", "false");
    await thought.click();
    await expect(reply).toContainText("Keep it short and confirm it stays local.");
    await expect(reply).toContainText("Thinking is shown live and never saved.");

    await page.getByRole("button", { name: /Target/ }).click();
    const group = page.getByRole("radiogroup", { name: "Choose a target" });
    await expect(group.getByRole("radio", { name: /^local On this/ })).not.toHaveAttribute("aria-disabled", "true");
    await expect(group.getByRole("radio", { name: /^fast/ })).toHaveAttribute("aria-disabled", "true");
    await expect(group.getByRole("radio", { name: /^fast/ })).toContainText("Private is on: local only");

    // axe on the live states the main a11y suite can't reach without sending (thinking open, picker open).
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });

  test("a budget cap blocks with a clear message", async ({ page }) => {
    await newChat(page);
    await send(page, "budget check");
    const alert = lastReply(page).getByRole("alert");
    await expect(alert).toContainText("Budget cap reached");
    await expect(alert).toContainText("Daily budget $1.00 reached ($1.02 spent today).");
    await expect(alert).toContainText("Free and local models still work");
  });

  test("image and video requests point to Studio", async ({ page }) => {
    await newChat(page);
    await send(page, "/image a red fox");
    await expect(lastReply(page)).toContainText("Image generation arrives in Studio (milestone M5)");
    await expect(lastReply(page).getByRole("link", { name: "Open Studio" })).toHaveAttribute("href", "/studio");
    await send(page, "/video waves at night");
    await expect(lastReply(page)).toContainText("Video generation arrives in Studio");
  });

  test("job-like requests answer in chat and offer Run as job (nothing starts by itself)", async ({ page }) => {
    await newChat(page);
    await send(page, "Fix the failing tests in my repo");
    const reply = lastReply(page);
    await expect(reply).toContainText("Run the tests and copy the first failure");
    const job = reply.getByRole("button", { name: "Run as job" });
    await expect(job).toBeEnabled();
    await expect(reply).toContainText("it can work on a copy of your project");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("thumbs up and down are saved and toggle", async ({ page }) => {
    await newChat(page);
    await send(page, "Why is the sky blue?");
    const reply = lastReply(page);
    const up = reply.getByRole("button", { name: "Good reply" });
    await up.click();
    await expect(up).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Thanks, noted for routing")).toBeVisible();
    await reply.getByRole("button", { name: "Bad reply" }).click();
    await expect(up).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await ready(page);
    await expect(lastReply(page).getByRole("button", { name: "Bad reply" })).toHaveAttribute("aria-pressed", "true");
  });

  test("regenerate, edit last message and stop", async ({ page }) => {
    await newChat(page);
    await send(page, "Why is the sky blue?");
    await expect(lastReply(page).getByRole("button", { name: /Why this\?/ })).toBeVisible();

    await lastReply(page).getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByRole("article", { name: "Assistant" })).toHaveCount(1);
    await expect(lastReply(page).getByRole("button", { name: /Why this\?/ })).toBeVisible();

    await page.getByRole("button", { name: "Edit message" }).click();
    await page.getByLabel("Edit your last message").fill("Write a python function");
    await page.getByRole("button", { name: "Save and resend" }).click();
    await expect(page.getByText("Write a python function")).toBeVisible();
    await expect(lastReply(page)).toContainText("reversed_items");

    await send(page, "Tell me about the sky once more");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(lastReply(page)).toContainText("Stopped. The reply so far is kept.");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("manual target pick is used for the next message", async ({ page }) => {
    await newChat(page);
    await page.getByRole("button", { name: /Target/ }).click();
    const group = page.getByRole("radiogroup", { name: "Choose a target" });
    await expect(group.getByRole("radio", { name: /^general/ })).toHaveAttribute("aria-disabled", "true");
    await expect(group.getByRole("radio", { name: /^general/ })).toContainText("Add a key for Mistral");
    await expect(group.getByRole("radio", { name: /openai\/gpt-oss-120b.*Best for code/ })).toBeVisible();
    await group.getByRole("radio", { name: /^smart-free/ }).click();
    await expect(page.getByRole("button", { name: /Target.*smart-free/ })).toBeVisible();
    await send(page, "Why is the sky blue?");
    await expect(lastReply(page).getByRole("button", { name: /by rule manual/ })).toBeVisible();
  });
});

test.describe("chat · composer and Home", () => {
  test("slash hints list the commands and complete with the keyboard", async ({ page }) => {
    await page.goto(`/chat?t=${SEED}`);
    await ready(page);
    const box = page.getByLabel("Message");
    await box.fill("/");
    const hints = page.getByRole("list", { name: "Slash commands" });
    await expect(hints.getByRole("button")).toHaveCount(7);
    await box.fill("/pr");
    await expect(hints.getByRole("button")).toHaveText([/\/private/]);
    await box.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue("/private ");
    await expect(hints).toHaveCount(0);
  });

  test("opening a thread shows the newest message; scrolling up by any means is never undone", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 }); // the seeded thread is taller than this
    await page.goto(`/chat?t=${SEED}`);
    const atEnd = () => page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
    await expect.poll(atEnd).toBe(true);
    // Not a wheel, key or touch: like dragging the scrollbar, find in page or a screen reader moving up.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    // While the pin would still be on (2.5 s), the page height changes (a lazy chunk arriving, the window resizing).
    await page.evaluate(() => document.getElementById("main")!.append(Object.assign(document.createElement("div"), { style: "height:40px" })));
    await page.setViewportSize({ width: 1280, height: 620 });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("seeded thread renders Markdown, highlighted code with copy, and the fallback chip", async ({ page }) => {
    await page.goto(`/chat?t=${SEED}`);
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Why the sky is blue");
    await expect(page.locator("pre code.hljs .hljs-comment")).toContainText("# [4, 3, 2, 1]");
    await expect(page.getByRole("button", { name: "Copy code" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Routed to Google AI Studio · gemini-3.1-flash-lite by rule default/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Good reply" }).first()).toHaveAttribute("aria-pressed", "true");
  });

  test("Home quick-start chips send real messages", async ({ page }) => {
    await page.goto(`${urls.mutating}/`);
    await ready(page);
    await page.getByRole("list", { name: "Quick starts" }).getByRole("button", { name: "Make an image" }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByText("Make an image of a calm sky with soft clouds at sunrise.")).toBeVisible();
    await expect(lastReply(page)).toContainText("Image generation arrives in Studio");

    await page.goto(`${urls.mutating}/`);
    await page.getByRole("list", { name: "Quick starts" }).getByRole("button", { name: "Fix failing tests" }).click();
    await expect(lastReply(page).getByRole("button", { name: "Run as job" })).toBeEnabled();
  });

  test("Home composer sends to chat", async ({ page }) => {
    await page.goto(`${urls.mutating}/`);
    await ready(page);
    await page.getByLabel("Message").fill("Why is the sky blue?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(lastReply(page)).toContainText("Rayleigh scattering");
  });
});

test.describe("chat · stream route guard", () => {
  const body = { mode: "send", text: "hi", target: "auto", private: false };
  test("rejects cross-origin and non-JSON posts", async ({ request }) => {
    const url = `${urls.main}/api/chat/stream`;
    const cross = await request.post(url, { data: body, headers: { Origin: "http://evil.example", "Content-Type": "application/json" } });
    expect(cross.status()).toBe(403);
    const none = await request.post(url, { data: body, headers: { "Content-Type": "application/json" } });
    expect(none.status()).toBe(403);
    const site = await request.post(url, { data: body, headers: { Origin: urls.main, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" } });
    expect(site.status()).toBe(403);
    const form = await request.post(url, { form: { text: "hi" }, headers: { Origin: urls.main } });
    expect(form.status()).toBe(415);
    const badTarget = await request.post(url, { data: { ...body, target: "agent:claude-code" }, headers: { Origin: urls.main } });
    expect(badTarget.status()).toBe(400);
  });
});
