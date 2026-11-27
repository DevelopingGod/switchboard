import { defineConfig, devices } from "@playwright/test";

// The console guard runs against `next dev`: React reports duplicate keys, bad nesting and hydration
// details only in development builds, so the production run in playwright.config.ts can't see them.
// Its own build folder (PORTAL_DIST_DIR) lets it run beside another `next dev` on this checkout.
const PORT = 3215;

export default defineConfig({
  testDir: "./tests/console",
  testMatch: /.*\.console\.ts/,
  workers: 1, // one dev server compiling routes on demand
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    timezoneId: "UTC",
  },
  webServer: {
    command: `npm run gen:tokens && PORTAL_DIST_DIR=.next-console PORTAL_DATA=fixture npx next dev -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
