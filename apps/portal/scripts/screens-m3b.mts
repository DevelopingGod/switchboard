/**
 * M3b screenshots into docs/screens/m3b/ (WebP): the sidebar expanded / collapsed / phone drawer in both
 * themes, the chat page at every tested width and browser zoom, and the Rules UI (Simple, Pro editor,
 * history, dry-run tester). Fixture data (no real keys, no real chats).
 *
 *   npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3215 &
 *   PORTAL_URL=http://127.0.0.1:3215 npx tsx scripts/screens-m3b.mts
 *
 * Zoom is emulated the way the layout test does it: fewer CSS pixels at a higher device scale factor.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.PORTAL_URL ?? "http://127.0.0.1:3215";
const out = join(import.meta.dirname, "../../../docs/screens/m3b");
mkdirSync(out, { recursive: true });
const SEED = "/chat?t=6f1c2a10-0000-4000-8000-000000000001";
const themes = { day: "light", dusk: "dark" } as const;

async function shot(browser: Browser, name: string, o: { w: number; h?: number; zoom?: number; theme?: "light" | "dark"; path: string; full?: boolean; act?: (p: Page) => Promise<void> }) {
  const zoom = o.zoom ?? 1;
  const ctx = await browser.newContext({
    viewport: { width: Math.round(o.w / zoom), height: o.h ?? 900 },
    deviceScaleFactor: zoom,
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${o.path}${o.path.includes("?") ? "&" : "?"}theme=${o.theme ?? "light"}&nosplash`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.getByRole("region", { name: "Recent chats" }).getByRole("link").first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  await o.act?.(page);
  await page.waitForTimeout(400);
  if (o.full) {
    // A full-page capture paints sticky bars where the viewport bottom is: put the save bar back in flow.
    await page.addStyleTag({ content: 'section[aria-label="Save changes"]{position:static!important}' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  }
  const file = join(out, `${name}.webp`);
  await sharp(await page.screenshot({ fullPage: !!o.full })).webp({ quality: 82 }).toFile(file);
  console.log(file);
  await ctx.close();
}

const pro = async (p: Page) => {
  await p.getByRole("complementary", { name: "Sidebar" }).getByRole("radio", { name: "Pro" }).click();
};
const openDrawer = async (p: Page) => {
  await p.getByRole("button", { name: "Open menu" }).click();
  await p.waitForTimeout(400);
};

const browser = await chromium.launch();

// Sidebar: expanded / collapsed / phone drawer, both themes.
for (const [tname, theme] of Object.entries(themes)) {
  await shot(browser, `sidebar-expanded-${tname}`, { w: 1440, theme, path: SEED });
  await shot(browser, `sidebar-collapsed-${tname}`, {
    w: 1440,
    theme,
    path: SEED,
    act: async (p) => {
      await p.getByRole("button", { name: "Collapse sidebar" }).click();
    },
  });
  await shot(browser, `sidebar-drawer-${tname}`, { w: 390, h: 844, theme, path: SEED, act: openDrawer });
}

// Every tested width (sidebar visible from 768 px; the phone widths show the drawer open), then zoom.
for (const w of [360, 768, 1024, 1280, 1440, 1920]) {
  await shot(browser, `width-${w}`, { w, h: w < 768 ? 800 : 900, path: SEED, act: w < 768 ? openDrawer : undefined });
}
for (const [base, zoom] of [[1280, 1.25], [1280, 1.5], [1920, 1.25], [1920, 1.5]] as const) {
  await shot(browser, `zoom-${zoom * 100}-of-${base}`, { w: base, zoom, path: SEED });
}
// A page whose grid used to depend on viewport breakpoints, at the widths where it broke.
for (const w of [768, 1024]) await shot(browser, `connections-${w}`, { w, path: "/connections", full: true });

// Rules UI.
for (const [tname, theme] of Object.entries(themes)) {
  await shot(browser, `rules-simple-${tname}`, { w: 1440, theme, path: "/settings/rules", full: true });
  await shot(browser, `rules-pro-${tname}`, {
    w: 1440,
    theme,
    path: "/settings/rules",
    full: true,
    act: async (p) => {
      await pro(p);
      await p.getByRole("tab", { name: "Rules" }).click();
      await p.getByRole("button", { name: "Edit writing", exact: true }).click();
      await p.getByLabel("Message to test").fill("Write a short LinkedIn post about my launch");
      await p.getByRole("button", { name: "Test routing" }).click();
      await p.getByRole("region", { name: "Decision" }).waitFor();
    },
  });
}
await shot(browser, "rules-validation-day", {
  w: 1440,
  path: "/settings/rules",
  full: true,
  act: async (p) => {
    await pro(p);
    await p.getByRole("tab", { name: "Rules" }).click();
    await p.getByRole("button", { name: "Edit writing", exact: true }).click();
    const form = p.getByRole("region", { name: "Rule: writing" });
    await form.getByLabel("Temperature").fill("9");
    await form.getByLabel("Goes to", { exact: true }).selectOption("__custom__");
    await form.getByRole("textbox", { name: "Goes to" }).fill("model:nope");
    await form.getByText("Temperature is between 0 and 2.").waitFor();
  },
});
await shot(browser, "rules-commands-day", {
  w: 1440,
  path: "/settings/rules",
  full: true,
  act: async (p) => {
    await pro(p);
    await p.getByRole("tab", { name: "Commands & classifier" }).click();
    await p.getByLabel("sensitive_health").waitFor();
  },
});
await shot(browser, "rules-history-day", {
  w: 1440,
  path: "/settings/rules",
  full: true,
  act: async (p) => {
    await pro(p);
    await p.getByRole("tab", { name: "Rules" }).click();
    await p.getByRole("button", { name: "Edit writing", exact: true }).click();
    await p.getByRole("region", { name: "Rule: writing" }).getByLabel("Goes to", { exact: true }).selectOption("model:fast");
    await p.getByLabel("Note for this version (optional)").fill("Prefer Groq for writing");
    await p.getByRole("button", { name: "Save changes" }).last().click();
    await p.getByText("Saved as version 1").first().waitFor();
    await p.getByRole("tab", { name: "History" }).click();
    await p.getByRole("button", { name: "Show changes" }).first().click();
    await p.getByText("Compared with the version before it").waitFor();
  },
});

await browser.close();
