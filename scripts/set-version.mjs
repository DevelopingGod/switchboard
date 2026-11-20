#!/usr/bin/env node
// Copies the one project version (root VERSION, ADR 0005) into every place that repeats it, so nobody edits the
// copies by hand. The same list is checked by scripts/check-docs.mjs (`npm run docs:check` in apps/portal).
//
//   echo 0.5.0 > VERSION && node scripts/set-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const version = read("VERSION").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`VERSION is not a semantic version: ${version}`);
  process.exit(1);
}

function edit(path, re, replace) {
  const before = read(path);
  if (!re.test(before)) {
    console.error(`${path}: the version pattern was not found (${re})`);
    process.exit(1);
  }
  const after = before.replace(re, replace);
  if (after !== before) writeFileSync(join(root, path), after);
  console.log(`${after !== before ? "updated" : "unchanged"}  ${path}`);
}

edit("services/router/pyproject.toml", /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
edit("apps/portal/package.json", /^(\s{2}"version":\s*")[^"]+(")/m, `$1${version}$2`);
// package-lock.json: the root package's version appears twice (top level and packages[""])
edit("apps/portal/package-lock.json", /^(\s{2}"version":\s*")[^"]+(")/m, `$1${version}$2`);
edit("apps/portal/package-lock.json", /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]+",\s*"version":\s*")[^"]+(")/, `$1${version}$2`);
edit("apps/portal/src/lib/server/fixtures.ts", /(version:\s*")\d+\.\d+\.\d+(",\s*\/\/ PROJECT_VERSION)/, `$1${version}$2`);
edit("README.md", /(badge\/version-)\d+\.\d+\.\d+(-)/, `$1${version}$2`);
