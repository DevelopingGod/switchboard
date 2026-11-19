import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { ready, settled } from "./helpers";

/** The sky covers the whole page, not just the first viewport (Routing rules used to turn white below ~900 px). */
const PAGES = ["/settings/rules", "/settings", "/connections", "/dev/components"];

for (const scheme of ["light", "dark"] as const) {
  for (const sky of ["css", "image"] as const) {
    test.describe(`full-page sky · ${scheme} · ${sky === "image" ? "sky image" : "css sky"}`, () => {
      test.use({ colorScheme: scheme });
      for (const path of PAGES) {
        test(path, async ({ page }) => {
          await page.goto(`${path}?theme=${scheme}&sky=${sky}`);
          await ready(page);
          await settled(page);
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          expect(height, "the page must be taller than one viewport for this test to mean anything").toBeGreaterThan(1000);
          const png = await page.screenshot({ fullPage: true });
          const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          // far-right strip (outside every card), sampled from below the first viewport to the page end
          const x = info.width - 3;
          for (const y of [1000, Math.floor(info.height * 0.7), info.height - 4]) {
            if (y >= info.height) continue;
            const i = (y * info.width + x) * 3;
            const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
            const white = r > 244 && g > 244 && b > 244;
            expect(white, `${path} ${scheme}/${sky}: pixel (${x},${y}) is white (${r},${g},${b})`).toBe(false);
            if (scheme === "dark") expect((r + g + b) / 3, `dark sky is light at y=${y}`).toBeLessThan(120);
          }
        });
      }
    });
  }
}
