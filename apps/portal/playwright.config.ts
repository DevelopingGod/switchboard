import { defineConfig, devices } from "@playwright/test";

const PORT = 3210; // 3100 is Paperclip
const FIRST_RUN_PORT = 3211; // fixture router with no onboarding record: Home redirects to /welcome
const MUTATING_PORT = 3212; // fixture router for tests that add keys / install CLIs (state is in memory)

export const urls = {
  main: `http://127.0.0.1:${PORT}`,
  firstRun: `http://127.0.0.1:${FIRST_RUN_PORT}`,
  mutating: `http://127.0.0.1:${MUTATING_PORT}`,
};

const server = (port: number, env = "") => ({
  command: `${env} PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p ${port}`,
  url: `http://127.0.0.1:${port}`,
  // The extra servers hold mutable fixture state, so a stale one must never be reused.
  reuseExistingServer: port === PORT,
  timeout: 60_000,
});

// Tests run against a production build: `npm run build` first (see docs/m05.md, docs/m1b.md).
// Every server runs with PORTAL_DATA=fixture: no Docker stack or real key is needed.
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  reporter: [["list"]],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  use: {
    baseURL: urls.main,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  },
  webServer: [
    server(PORT),
    server(FIRST_RUN_PORT, "PORTAL_FIXTURE_ONBOARDING=none"),
    server(MUTATING_PORT),
  ],
});
