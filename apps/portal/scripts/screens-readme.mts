/**
 * README screenshots into docs/media/shot-<name>-{day,dusk}.webp (1000 px wide, WebP). Fixture data only:
 * no real key, chat or name. Shipped features only (every shot is a screen that exists today).
 *
 *   npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3215 &
 *   PORTAL_URL=http://127.0.0.1:3215 npm run screens:readme        (then stop the server: it sent one message)
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.PORTAL_URL ?? "http://127.0.0.1:3215";
const out = join(import.meta.dirname, "../../../docs/media");
mkdirSync(out, { recursive: true });
const SEED = "/chat?t=6f1c2a10-0000-4000-8000-000000000001";
const themes = { day: "light", dusk: "dark" } as const;

const shots: Record<string, { path: string; act?: (p: Page) => Promise<void> }> = {
  home: { path: "/" },
  "chat-why": {
    path: SEED,
    act: async (p) => {
      await p.getByRole("button", { name: /Why this\? Routed to Google AI Studio/ }).click();
      await p.getByRole("dialog", { name: "Why this route?" }).waitFor();
    },
  },
  "chat-private": {
    path: "/chat",
    act: async (p) => {
      await p.getByRole("switch", { name: "Private" }).click();
      await p.getByLabel("Message").fill("Summarise my notes from this morning");
      await p.getByLabel("Message").press("Enter");
      await p.getByRole("button", { name: /Routed to Ollama/ }).waitFor();
    },
  },
  connections: { path: "/connections" },
  rules: {
    path: "/settings/rules",
    act: async (p) => {
      await p.addStyleTag({ content: 'section[aria-label="Save changes"]{display:none!important}' }); // sticky bar overlaps a card
      await p.getByLabel("Message to test").fill("Write a short LinkedIn post about my launch");
      await p.getByRole("button", { name: "Test routing" }).click();
      await p.getByRole("region", { name: "Decision" }).waitFor();
    },
  },
  "wizard-goals": { path: "/welcome?step=2" },
  "wizard-connect": { path: "/welcome?step=3" },
};

const browser = await chromium.launch();
const only = process.argv.slice(2);
let total = 0;
for (const [name, { path, act }] of Object.entries(shots)) {
  if (only.length && !only.includes(name)) continue;
  for (const [tname, theme] of Object.entries(themes)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${path}${path.includes("?") ? "&" : "?"}theme=${theme}&nosplash`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await page.getByRole("region", { name: "Recent chats" }).getByRole("link").first().waitFor({ timeout: 4000 }).catch(() => {});
    await act?.(page);
    await page.waitForTimeout(500);
    const png = await page.screenshot();
    const file = join(out, `shot-${name}-${tname}.webp`);
    await sharp(png).resize({ width: 1000 }).webp({ quality: 78, effort: 6 }).toFile(file);
    const kb = statSync(file).size / 1024;
    total += kb;
    console.log(`shot-${name}-${tname}.webp  ${kb.toFixed(0)} KB`);
    await ctx.close();
  }
}
await browser.close();
console.log(`total ${(total / 1024).toFixed(2)} MB`);
