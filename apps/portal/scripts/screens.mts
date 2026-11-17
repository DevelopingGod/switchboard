/**
 * Full-page screenshots into docs/screens/: / and /dev/components (both themes, CSS sky and sky image),
 * plus Connections and each wizard step (both themes, CSS sky).
 * Needs a production server on fixture data: npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3210
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.PORTAL_URL ?? "http://127.0.0.1:3210";
const out = join(import.meta.dirname, "../../../docs/screens");
mkdirSync(out, { recursive: true });

const withSky = { "": "css", "-sky": "image" } as const;
const cssOnly = { "": "css" } as const;
const pages: Record<string, { path: string; skies: Record<string, string> }> = {
  home: { path: "/", skies: withSky },
  components: { path: "/dev/components", skies: withSky },
  connections: { path: "/connections", skies: cssOnly },
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`welcome-${n}`, { path: `/welcome?step=${n}`, skies: cssOnly }])),
};
const themes = { day: "light", dusk: "dark" } as const;

const browser = await chromium.launch();
for (const [pname, { path, skies }] of Object.entries(pages)) {
  for (const [tname, theme] of Object.entries(themes)) {
    for (const [suffix, sky] of Object.entries(skies)) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}${path}${path.includes("?") ? "&" : "?"}theme=${theme}&sky=${sky}`);
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
