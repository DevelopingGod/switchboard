/** SPEC §8c: < 200 KB initial JS per route (gzip). Reads the production build's route stats. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..");
const BUDGET = 200 * 1024;
const stats: { route: string; firstLoadChunkPaths: string[] }[] = JSON.parse(
  readFileSync(join(root, ".next/diagnostics/route-bundle-stats.json"), "utf8"),
);

let failed = false;
for (const { route, firstLoadChunkPaths } of stats) {
  const gz = firstLoadChunkPaths.reduce((n, p) => n + gzipSync(readFileSync(join(root, p))).length, 0);
  const ok = gz < BUDGET;
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"} ${route.padEnd(18)} ${(gz / 1024).toFixed(1)} KB gzip`);
}
process.exit(failed ? 1 : 0);
