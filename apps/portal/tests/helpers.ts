import type { Page } from "@playwright/test";

/** Waits for web fonts so screenshots and axe see final layout. */
export async function ready(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
}

/** Sticky chrome would overlay tall element screenshots. */
export async function unstick(page: Page) {
  await page.addStyleTag({ content: "header{position:static!important}" });
}

/** Full-page shots: the chat composer is sticky to the viewport bottom and would cover messages. */
export async function unstickComposer(page: Page) {
  await page.addStyleTag({ content: "form.lg\\:sticky{position:static!important}" });
}
