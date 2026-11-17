/**
 * Full-page screenshots of / and /dev/components (both themes, CSS sky and sky image) into docs/screens/.
 * Needs a production server on :3210 (npm run build && npx next start -p 3210).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.PORTAL_URL ?? "http://localhost:3210";
const out = join(import.meta.dirname, "../../../docs/screens");
mkdirSync(out, { recursive: true });

const pages = { home: "/", components: "/dev/components" } as const;
const themes = { day: "light", dusk: "dark" } as const;
const skies = { "": "css", "-sky": "image" } as const;

const browser = await chromium.launch();
for (const [pname, path] of Object.entries(pages)) {
  for (const [tname, theme] of Object.entries(themes)) {
    for (const [suffix, sky] of Object.entries(skies)) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}${path}?theme=${theme}&sky=${sky}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      // The sky is position:fixed, so grow the viewport to the page height for a seamless backdrop.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: 1440, height });
      await page.waitForTimeout(300);
      const file = join(out, `${pname}-${tname}${suffix}.webp`);
      // WebP keeps the committed screenshots small (the gradients make PNGs 3–4 MB).
      await sharp(await page.screenshot()).webp({ quality: 88 }).toFile(file);
      console.log(file);
      await ctx.close();
    }
  }
}
await browser.close();
