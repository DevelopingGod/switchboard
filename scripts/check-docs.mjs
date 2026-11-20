#!/usr/bin/env node
/**
 * README / docs checks (CLAUDE.md "Definition of done"). No dependencies, no network by default.
 *   node scripts/check-docs.mjs            (or: cd apps/portal && npm run docs:check)
 *   node scripts/check-docs.mjs --online   also HEAD-check external https links (slow, needs the network)
 *
 * Fails (exit 1) when:
 *  - a relative link or image in README.md / CONTRIBUTING.md points at a missing file or heading;
 *  - an image has no alt text (Markdown or HTML <img>);
 *  - a local image is outside docs/media, or media is over budget (hero/routing SVG >= 60 KB,
 *    demo GIF >= 5 MB, all of docs/media >= 15 MB);
 *  - the version differs between VERSION, the router, the portal (package.json, lockfile, fixtures)
 *    and the README badge;
 *  - the README roadmap disagrees with the docs/PROGRESS.md status table.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");
const problems = [];
const fail = (where, msg) => problems.push(`${where}: ${msg}`);
const read = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------- links, images, alt text
const DOCS = ["README.md", "CONTRIBUTING.md"].filter((f) => existsSync(join(root, f)));
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
const anchorsOf = (md) => {
  const set = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      let s = slug(m[1]);
      const n = seen.get(s) ?? 0;
      seen.set(s, n + 1);
      if (n) s += `-${n}`;
      set.add(s);
    }
    for (const a of line.matchAll(/<(?:a|h\d|details|section)\b[^>]*\b(?:id|name)="([^"]+)"/g)) set.add(a[1]);
  }
  return set;
};
const mediaUrls = new Set();
const external = new Set();

for (const file of DOCS) {
  const md = read(file);
  const noCode = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const anchors = anchorsOf(md);
  const refs = []; // {url, kind, alt}
  for (const m of noCode.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) refs.push({ url: m[3], kind: m[1] ? "img" : "link", alt: m[2] });
  for (const m of noCode.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc="([^"]*)"/i.exec(m[0])?.[1];
    const alt = /\balt="([^"]*)"/i.exec(m[0])?.[1];
    if (src) refs.push({ url: src, kind: "img", alt: alt ?? null });
  }
  for (const m of noCode.matchAll(/<source\b[^>]*\bsrcset="([^"]*)"/gi)) refs.push({ url: m[1].split(/\s+/)[0], kind: "source" });
  for (const m of noCode.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) refs.push({ url: m[1], kind: "link" });
  for (const m of noCode.matchAll(/<video\b[^>]*\bsrc="([^"]*)"/gi)) refs.push({ url: m[1], kind: "source" });

  for (const { url, kind, alt } of refs) {
    if ((kind === "img") && (alt == null || alt.trim() === "")) fail(file, `image without alt text: ${url}`);
    if (/^(https?:)?\/\//.test(url)) {
      external.add(url);
      if (kind === "img" || kind === "source") {
        // third-party badges and the star history chart are the only images allowed off-repo
        if (!/^https:\/\/(img\.shields\.io|api\.star-history\.com|star-history\.com)\//.test(url)) fail(file, `external image not allowed (media lives in docs/media): ${url}`);
      }
      continue;
    }
    if (/^(mailto:|data:)/.test(url)) continue;
    const [pathPart, hash] = url.split("#");
    const target = pathPart === "" ? file : normalize(join(dirname(file), decodeURI(pathPart.split("?")[0])));
    if (!existsSync(join(root, target))) {
      fail(file, `broken ${kind === "link" ? "link" : "image/file reference"}: ${url}`);
      continue;
    }
    if (kind !== "link") {
      mediaUrls.add(target);
      if (!target.startsWith("docs/media/")) fail(file, `media must live in docs/media/: ${url}`);
    }
    if (hash && target.endsWith(".md")) {
      const set = target === file ? anchors : anchorsOf(read(target));
      if (!set.has(hash)) fail(file, `missing heading anchor: ${url}`);
    }
  }
}

// ---------------------------------------------------------------- media budgets
const mediaDir = join(root, "docs/media");
let total = 0;
if (existsSync(mediaDir)) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(mediaDir)) {
    const size = statSync(f).size;
    total += size;
    const rel = relative(root, f);
    if (/\.svg$/.test(f) && /(hero|routing)-/.test(f) && size >= 60 * 1024) fail(rel, `animated SVG must be < 60 KB (is ${(size / 1024).toFixed(1)} KB)`);
    if (/\.gif$/.test(f) && size >= 5 * 1024 * 1024) fail(rel, `GIF must be < 5 MB (is ${(size / 1048576).toFixed(2)} MB)`);
  }
  if (total >= 15 * 1024 * 1024) fail("docs/media", `total media must be < 15 MB (is ${(total / 1048576).toFixed(2)} MB)`);
}
const unusedOk = /\.(mp4|webm)$/; // linked, not embedded; checked as links above
for (const f of existsSync(mediaDir) ? readdirSync(mediaDir) : []) {
  const rel = `docs/media/${f}`;
  if (!mediaUrls.has(rel) && !unusedOk.test(f) && !read("README.md").includes(rel)) fail(rel, "media file is not used by the README (delete it or use it)");
}

// ---------------------------------------------------------------- one version everywhere
const version = read("VERSION").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) fail("VERSION", `not a semantic version: ${version}`);
const copies = {
  "services/router/pyproject.toml": /^version\s*=\s*"([^"]+)"/m.exec(read("services/router/pyproject.toml"))?.[1],
  "apps/portal/package.json": JSON.parse(read("apps/portal/package.json")).version,
  "apps/portal/package-lock.json": JSON.parse(read("apps/portal/package-lock.json")).version,
  "apps/portal/src/lib/server/fixtures.ts": /version:\s*"(\d+\.\d+\.\d+)",\s*\/\/ PROJECT_VERSION/.exec(read("apps/portal/src/lib/server/fixtures.ts"))?.[1],
  "README.md (version badge)": /badge\/version-(\d+\.\d+\.\d+)-/.exec(read("README.md"))?.[1],
};
for (const [where, v] of Object.entries(copies)) if (v !== version) fail(where, `version ${v ?? "(missing)"} differs from VERSION ${version}`);
if (/FastAPI\([^)]*version="\d/.test(read("services/router/app/main.py"))) fail("services/router/app/main.py", "version is hard-coded: read app.version.VERSION");

// ---------------------------------------------------------------- roadmap vs PROGRESS
const progress = read("docs/PROGRESS.md");
const status = new Map(); // milestone id -> shipped?
for (const line of progress.split("\n")) {
  const m = /^\|\s*(M[\d.]+[ab]?)\s+([^|]*)\|\s*([^|]*)\|/.exec(line);
  if (!m) continue;
  const state = m[3];
  if (/Split into/i.test(state)) continue; // parent rows of a split milestone: the leaves carry the state
  status.set(m[1], state.trim().startsWith("✅"));
}
const readme = read("README.md");
const block = /<!-- roadmap:start -->([\s\S]*?)<!-- roadmap:end -->/.exec(readme)?.[1];
if (!block) fail("README.md", "roadmap block markers (<!-- roadmap:start --> / <!-- roadmap:end -->) not found");
else {
  const listed = new Map();
  for (const line of block.split("\n")) {
    const m = /^\|\s*(✅|🔜|💡)\s*\|\s*\*\*(M[\d.]+[ab]?)\*\*/.exec(line);
    if (m) listed.set(m[2], m[1] === "✅");
  }
  for (const [id, shipped] of status) {
    if (!listed.has(id)) fail("README.md", `roadmap is missing ${id}`);
    else if (listed.get(id) !== shipped) fail("README.md", `roadmap shows ${id} as ${listed.get(id) ? "shipped (✅)" : "not shipped"}, docs/PROGRESS.md says ${shipped ? "✅ Merged" : "not merged"}`);
  }
  for (const id of listed.keys()) if (!status.has(id)) fail("README.md", `roadmap lists ${id}, which is not in the PROGRESS status table`);
}

// ---------------------------------------------------------------- optional: external links
if (online) {
  for (const url of external) {
    if (/img\.shields\.io|star-history/.test(url)) continue;
    try {
      const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (r.status >= 400 && r.status !== 403 && r.status !== 429) fail("external", `${url} -> ${r.status}`);
    } catch (e) {
      fail("external", `${url} -> ${e.message}`);
    }
  }
}

if (problems.length) {
  console.error(`docs check: ${problems.length} problem(s)\n` + problems.map((p) => `  ✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`docs check: OK (${DOCS.join(", ")}; ${mediaUrls.size} media file(s), docs/media ${(total / 1048576).toFixed(2)} MB; version ${version}; ${status.size} milestones)`);
