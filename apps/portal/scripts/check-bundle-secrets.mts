/**
 * Proves ROUTER_ADMIN_TOKEN never reaches the browser (SPEC §13.2, M1b).
 *
 *  1. Builds with a sentinel token (skip with --no-build to reuse .next).
 *  2. Greps everything a browser can receive from the build: .next/static (client bundles) and the
 *     prerendered HTML / RSC payloads. Neither the sentinel nor the variable's name may appear.
 *  3. Starts the server with the sentinel set and fetches every screen, checking each response body.
 *  4. Checks that no "use client" source file imports the server-only data layer.
 *
 * Usage: npm run test:bundle
 */
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = "sbx-admin-sentinel-7f3a9c0e41d2";
const PORT = 3213;
const root = join(import.meta.dirname, "..");
const failures: string[] = [];

if (!process.argv.includes("--no-build")) {
  console.log("Building with a sentinel ROUTER_ADMIN_TOKEN…");
  const r = spawnSync("npx", ["next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ROUTER_ADMIN_TOKEN: SENTINEL, PORTAL_DATA: "fixture" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const bad = (text: string) => text.includes(SENTINEL) || text.includes("ROUTER_ADMIN_TOKEN");

// 2. build output the browser can receive
const clientFiles = [
  ...walk(join(root, ".next/static")),
  ...[...walk(join(root, ".next/server/app"))].filter((f) => /\.(html|rsc)$/.test(f)),
];
for (const f of clientFiles) if (bad(readFileSync(f, "utf8"))) failures.push(`build output leaks the token: ${f}`);
console.log(`Checked ${clientFiles.length} client-reachable build files.`);

// 4. source rule: client components never import the server data layer
for (const f of walk(join(root, "src"))) {
  if (!/\.(tsx?|mts)$/.test(f)) continue;
  const src = readFileSync(f, "utf8");
  if (/^\s*["']use client["']/m.test(src) && /from ["']@\/lib\/server\//.test(src)) {
    failures.push(`client component imports the server layer: ${f}`);
  }
}

// 3. running server
const server = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], {
  cwd: root,
  env: { ...process.env, ROUTER_ADMIN_TOKEN: SENTINEL, PORTAL_DATA: "fixture" },
  stdio: "ignore",
});
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (const path of ["/", "/connections", "/welcome", "/welcome?step=3", "/chat", "/settings"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { RSC: "1" } });
    const html = await (await fetch(`http://127.0.0.1:${PORT}${path}`)).text();
    const rsc = await res.text();
    for (const [kind, body] of [["html", html], ["rsc", rsc]] as const) {
      if (bad(body) || /bearer\s/i.test(body)) failures.push(`${path} (${kind}) leaks the token or an Authorization header`);
    }
  }
  // The install log endpoint only answers same-origin loopback requests.
  const evil = await fetch(`http://127.0.0.1:${PORT}/api/install/x/events`, {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  if (evil.status !== 403) failures.push(`install log endpoint answered a cross-site request (${evil.status})`);
  // fetch() cannot override Host, so use a raw request to simulate DNS rebinding.
  const rebindStatus = await new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/install/x/events", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
  if (rebindStatus !== 403) failures.push(`install log endpoint answered a foreign Host (${rebindStatus})`);
} finally {
  server.kill();
}

if (failures.length) {
  console.error("FAIL\n" + failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
console.log("PASS: ROUTER_ADMIN_TOKEN never reaches the browser.");
