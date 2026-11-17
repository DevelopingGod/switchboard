/**
 * Lighthouse gate for /dev/components (and the home shell) in both themes.
 * Needs a production server: `npm run build && npx next start -p 3210`.
 * Categories: performance, accessibility, best-practices (SEO intentionally excluded). Threshold 90.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PORTAL_URL ?? "http://localhost:3210";
const THRESHOLD = 90;
const targets = ["/dev/components", "/dev/components?theme=dark", "/", "/?theme=dark"];
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
