import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { urls } from "../playwright.config";
import { ready } from "./helpers";

/**
 * M2.5: attachments in chat (paperclip, drag-and-drop, paste; chips, estimate, refusals, private images, files on
 * the message, safe serving) and Metrics → Activity (list, filters, search privacy, Why dialog, CSV). Fixture
 * data: the portal's attachments fixture sniffs bytes like the router does.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFUlEQVR4nGPo6Oj4jwMwIEswMPj/BwCKNA5gFcwZ6AAAAABJRU5ErkJggg==",
  "base64",
);

// Uploads and chats change fixture state: the mutating server, never the shared read-only one.
const M = urls.mutating;

async function newChat(page: Page) {
  await page.goto(`${M}/chat`);
  await ready(page);
}

async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  // The paperclip opens the hidden file input.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Attach files/ }).click();
  await (await chooser).setFiles(files);
}

const tray = (page: Page) => page.getByRole("list", { name: "Attachments" });
const lastReply = (page: Page) => page.getByRole("article", { name: "Assistant" }).last();

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
}

test.describe("attachments", () => {
  test("attach an image, see the estimate, send: vision model, files on the message", async ({ page }) => {
    await newChat(page);
    await attach(page, [{ name: "chart.png", mimeType: "image/png", buffer: PNG }]);
    const chip = tray(page).getByRole("listitem").filter({ hasText: "chart.png" });
    await expect(chip).toContainText(/\d+ B/);
    await expect(page.locator("[data-estimate]")).toHaveText("≈ 1,032 tokens on Google AI Studio · gemini-3.1-flash-lite");
    await page.getByLabel("Message").fill("What does this chart show?");
    await axe(page);
    await page.getByRole("button", { name: "Send" }).click();
    const reply = lastReply(page);
    await expect(reply).toContainText("The chart shows monthly requests");
    await expect(tray(page)).toHaveCount(0); // the composer is empty again
    const img = page.getByRole("img", { name: "Attached image: chart.png" });
    await expect(img).toBeVisible();
    await expect(page.getByRole("link", { name: "Open chart.png" })).toHaveAttribute("target", "_blank");
    await reply.getByRole("button", { name: /Why/ }).first().click();
    await expect(page.getByText("It can read the image you attached.")).toBeVisible();
  });

  test("a message can be only files; drop and paste attach too", async ({ page }) => {
    await newChat(page);
    const form = page.locator("form").filter({ has: page.getByLabel("Message") });
    // Drag and drop a text file onto the composer.
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["a,b\n1,2\n"], "numbers.csv", { type: "text/csv" }));
      return d;
    });
    await form.dispatchEvent("dragover", { dataTransfer: dt });
    await expect(page.getByText("Drop files to attach them")).toBeVisible();
    await form.dispatchEvent("drop", { dataTransfer: dt });
    await expect(tray(page).getByRole("listitem").filter({ hasText: "numbers.csv" })).toBeVisible();
    // Paste a screenshot into the text box.
    await page.getByLabel("Message").focus();
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const d = new DataTransfer();
      d.items.add(new File([bytes], "image.png", { type: "image/png" }));
      const ev = new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true });
      document.querySelector("textarea[data-composer]")!.dispatchEvent(ev);
    }, PNG.toString("base64"));
    await expect(tray(page).getByRole("listitem").filter({ hasText: /^screenshot-/ })).toBeVisible();
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled(); // no text needed
    await send.click();
    await expect(page.getByRole("link", { name: "Download numbers.csv" })).toBeVisible();
  });

  test("refused files say why, and can be removed", async ({ page }) => {
    await newChat(page);
    await attach(page, [
      { name: "cat.png", mimeType: "image/png", buffer: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]) },
      { name: "page.html", mimeType: "text/html", buffer: Buffer.from("<html><script>alert(1)</script></html>") },
    ]);
    await expect(tray(page).getByRole("listitem").filter({ hasText: "cat.png" })).toContainText("This looks like a program");
    await expect(tray(page).getByRole("listitem").filter({ hasText: "page.html" })).toContainText("HTML and SVG files aren't accepted");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByRole("button", { name: "Remove cat.png" }).click();
    await page.getByRole("button", { name: "Remove page.html" }).click();
    await expect(tray(page)).toHaveCount(0);
  });

  test("a private image never leaves the machine: a clear message instead", async ({ page }) => {
    await newChat(page);
    await page.getByRole("switch", { name: "Private" }).click();
    await attach(page, [{ name: "scan.png", mimeType: "image/png", buffer: PNG }]);
    await expect(page.locator("[data-estimate]")).toContainText("A private image stays on this computer");
    await page.getByLabel("Message").fill("read this");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(lastReply(page)).toContainText("a private image never goes to the cloud");
  });

  test("files are served safely: only images inline, everything else a download", async ({ page, request }) => {
    await newChat(page);
    await attach(page, [
      { name: "shot.png", mimeType: "image/png", buffer: PNG },
      { name: "spec.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n/OpenAction << /S /JavaScript /JS (app.alert(1)) >>\n") },
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n<script>alert(1)</script> hello") },
    ]);
    await expect(tray(page).getByRole("listitem")).toHaveCount(3);
    await expect(tray(page).getByText("Uploading…")).toHaveCount(0);
    await page.getByRole("button", { name: "Send" }).click();
    const links = page.locator("[data-message-attachments] a");
    await expect(links).toHaveCount(3);
    const hrefs = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    for (const href of hrefs) {
      const r = await request.get(M + href, { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(r.status()).toBe(200);
      const h = r.headers();
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["content-security-policy"]).toContain("sandbox");
      if (h["content-type"].startsWith("image/")) {
        expect(h["content-disposition"]).toMatch(/^inline/);
        expect(h["content-security-policy"]).toContain("default-src 'none'");
      } else {
        expect(h["content-type"]).toBe("application/octet-stream");
        expect(h["content-disposition"]).toMatch(/^attachment/);
      }
    }
    // Following a document link downloads it; nothing is rendered (or run) on the portal's origin.
    let dialogs = 0;
    page.on("dialog", (d) => (dialogs++, d.dismiss()));
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download notes.md" }).click()]);
    expect(dl.suggestedFilename()).toBe("notes.md");
    expect(dialogs).toBe(0);
    // Cross-site reads are refused.
    const cross = await request.get(M + hrefs[0], { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(cross.status()).toBe(403);
  });

  test("uploads need the portal's own origin", async ({ request }) => {
    const r = await request.post(`${M}/api/attachments`, {
      headers: { "Content-Type": "application/octet-stream", "X-Filename": "a.txt", Origin: "https://evil.example" },
      data: Buffer.from("hi"),
    });
    expect(r.status()).toBe(403);
    const ok = await request.post(`${M}/api/attachments`, {
      headers: { "Content-Type": "application/octet-stream", "X-Filename": "a.txt", Origin: M },
      data: Buffer.from("hi"),
    });
    expect(ok.status()).toBe(200);
  });
});

test.describe("activity", () => {
  async function open(page: Page) {
    await page.clock.setFixedTime(new Date("2026-11-21T17:00:00Z"));
    await page.goto("/metrics/activity");
    await ready(page);
  }
  const rows = (page: Page) => page.getByRole("list", { name: "Activity" }).getByRole("listitem");

  test("every kind of request, private chats labelled, keyset paging", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(rows(page)).toHaveCount(50);
    await expect(rows(page).filter({ hasText: "Private chat" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Title · Why is the sky blue?" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Model test: groq/openai/gpt-oss-20b" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(rows(page)).toHaveCount(60);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    await axe(page);
  });

  test("filters and title search (never private chats)", async ({ page }) => {
    await open(page);
    await page.getByLabel("Kind").selectOption("job");
    await expect(rows(page).first()).toContainText("Fix the failing tests in api/");
    await expect(rows(page).first().getByRole("link", { name: "Fix the failing tests in api/" })).toHaveAttribute("href", "/jobs/14");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Search titles").fill("chart");
    await expect(rows(page).first()).toContainText("What does this chart show?");
    await expect(rows(page).filter({ hasNotText: "chart" })).toHaveCount(0);
    await page.getByLabel("Search titles").fill("Private");
    await expect(page.getByText("Nothing matches.")).toBeVisible();
  });

  test("Why this? for a row", async ({ page }) => {
    await open(page);
    await rows(page).filter({ hasText: "What does this chart show?" }).first().getByRole("button").click();
    const dialog = page.getByRole("dialog", { name: "Why this model" });
    await expect(dialog).toContainText("Needs vision: this message has an image");
    await axe(page);
  });

  test("CSV of the filtered rows is formula-safe", async ({ page }) => {
    await open(page);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download CSV" }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^switchboard-activity-7d-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = (await readFile((await dl.path())!, "utf8")).replace(/^﻿/, "");
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("at,kind,label,provider,model,rule,status,latency_ms,cost_usd,value_usd,fallbacks,job_id");
    expect(text).toContain(`"'=HYPERLINK(""x"") budget plan"`);
    expect(text).not.toMatch(/,=HYPERLINK/);
  });
});
