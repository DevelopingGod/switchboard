/**
 * Lighthouse gate for the gallery, Home, Connections, Chat, Settings, Status, Rules, the wizard and (M4b) the
 * jobs, agents and projects pages, in both themes.
 * Needs a production server on fixture data: `npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3210`.
 * Categories: performance, accessibility, best-practices (SEO intentionally excluded). Threshold 90.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PORTAL_URL ?? "http://127.0.0.1:3210";
const THRESHOLD = 90;
const targets = [
  "/dev/components",
  "/dev/components?theme=dark",
  "/",
  "/?theme=dark",
  "/connections",
  "/connections?theme=dark",
  "/welcome?step=3",
  "/welcome?step=3&theme=dark",
  "/chat?t=6f1c2a10-0000-4000-8000-000000000001",
  "/chat?t=6f1c2a10-0000-4000-8000-000000000001&theme=dark",
  "/settings",
  "/settings?theme=dark",
  "/status",
  "/status?theme=dark",
  "/settings/rules",
  "/settings/rules?theme=dark",
  // M4b
  "/jobs",
  "/jobs?theme=dark",
  "/jobs/30",
  "/jobs/30?theme=dark",
  "/jobs/28",
  "/jobs/28?theme=dark",
  "/jobs/agents",
  "/jobs/agents?theme=dark",
  "/settings/projects",
  "/settings/projects?theme=dark",
  // M6
  "/metrics",
  "/metrics?theme=dark",
  "/metrics?mode=pro",
  "/metrics?mode=pro&theme=dark",
];
const chrome =
  process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome");

const dir = mkdtempSync(join(tmpdir(), "lh-"));
let failed = false;

for (const [i, path] of targets.entries()) {
  const out = join(dir, `${i}.json`);
  execFileSync(
    "npx",
    [
      "--prefix",
      process.cwd(),
      "lighthouse",
      BASE + path,
      "--output=json",
      `--output-path=${out}`,
      "--only-categories=performance,accessibility,best-practices",
      "--chrome-flags=--headless=new --no-sandbox",
      "--quiet",
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      // Under WSL chrome-launcher builds a Windows-style profile path (C:\\Users\\…) that a Linux Chrome treats
      // as relative to the cwd, so run from a scratch dir instead of the repo.
      cwd: dir,
      env: { ...process.env, CHROME_PATH: chrome },
    },
  );
  const { categories, audits } = JSON.parse(readFileSync(out, "utf8"));
  const scores = Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, Math.round((v as { score: number }).score * 100)]));
  const ok = Object.values(scores).every((s) => (s as number) >= THRESHOLD);
  failed ||= !ok;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${path.padEnd(30)} perf ${scores.performance}  a11y ${scores.accessibility}  best-practices ${scores["best-practices"]}` +
      `  (LCP ${audits["largest-contentful-paint"].displayValue}, TBT ${audits["total-blocking-time"].displayValue}, CLS ${audits["cumulative-layout-shift"].displayValue})`,
  );
}
process.exit(failed ? 1 : 0);
