/**
 * Records the README demo against the throwaway Demo stack (docs/recording-the-demo.md):
 *   Home → chat with "Why this?" → private chat → Connections → Rules tester → Jobs → Agents.
 * The jobs segment (M4b) runs on a second portal with fixture data, labelled "Sample data" on screen: a real job
 * through the Demo stack would reuse job numbers (branches `switchboard/job-<n>`, Paperclip issue keys) that your
 * real jobs already use in the shared Paperclip company and project.
 * Real replies from the real providers and the local model, but a separate "Demo" database: none of your
 * chats, titles or key suffixes can appear. Output: docs/media/demo.mp4 and docs/media/demo.gif (< 5 MB).
 *
 *   scripts/demo-stack.sh up                  (reset the demo database, start the demo router on :8110)
 *   npm run build                             (the demo portal is a production server on :3220)
 *   npm run demo:record                       (this script)
 *   scripts/demo-stack.sh down                (remove the demo router and database)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";
import ffmpegPath from "ffmpeg-static";

const ROUTER = process.env.DEMO_ROUTER_URL ?? "http://127.0.0.1:8110";
const PORT = Number(process.env.DEMO_PORTAL_PORT ?? 3220);
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE_PORT = PORT + 1;
const SAMPLE = `http://127.0.0.1:${SAMPLE_PORT}`;
const root = join(import.meta.dirname, "../../..");
const media = join(root, "docs/media");
const tmp = join(import.meta.dirname, "../test-results/demo-video");
const W = 1280;
const H = 720;
const LIMIT_GIF = 5 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[demo] ${m}`);

/** Harmless storyboard prompts: nothing personal, health or financial. */
const PROMPTS = {
  home: "Explain in two sentences why the sky is blue.",
  private: "What is 2 plus 2? Answer with one word.",
  rules: "Fix this Python traceback: KeyError: 'name'",
};

async function preflight() {
  const h = await fetch(`${ROUTER}/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (!h?.ok) throw new Error(`The demo router is not running at ${ROUTER}. Run: scripts/demo-stack.sh up`);
  const token = readFileSync(join(import.meta.dirname, "../.env.local"), "utf8").match(/^ROUTER_ADMIN_TOKEN=(.+)$/m)?.[1];
  const t = await fetch(`${ROUTER}/chat/threads`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  if ((t.threads?.length ?? 0) + (t.pinned?.length ?? 0) > 0) throw new Error("The demo database already has chats. Run: scripts/demo-stack.sh reset");
}

async function startPortal(port = PORT, env: Record<string, string> = { ROUTER_URL: ROUTER }): Promise<ChildProcess> {
  const p = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    detached: true,
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false)) return p;
    await sleep(500);
  }
  throw new Error("The demo portal did not start (did you run npm run build?)");
}

/** The on-screen label for the jobs segment (fixture data). */
async function sampleLabel(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById("demo-sample")) return;
    const d = document.createElement("div");
    d.id = "demo-sample";
    d.textContent = "Sample data · jobs run on your own repos";
    d.style.cssText = "position:fixed;z-index:2147483646;right:16px;bottom:64px;padding:6px 12px;border-radius:999px;background:#171a3d;color:#fff;font:600 13px system-ui;opacity:.92";
    document.body.appendChild(d);
  });
}

/** A visible pointer for the recording (Playwright's video has none): a soft dot with a click ripple. */
const CURSOR = `(() => {
  const mk = () => {
    if (document.getElementById("demo-cursor")) return;
    const d = document.createElement("div");
    d.id = "demo-cursor";
    d.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(75,80,196,.35);border:2px solid #4b50c4;pointer-events:none;transition:transform .12s ease-out,background .12s";
    document.documentElement.appendChild(d);
    addEventListener("mousemove", (e) => { d.style.left = e.clientX + "px"; d.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { d.style.transform = "scale(.7)"; d.style.background = "rgba(75,80,196,.7)"; }, true);
    addEventListener("mouseup", () => { d.style.transform = ""; d.style.background = "rgba(75,80,196,.35)"; }, true);
  };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", mk) : mk();
})();`;

async function glide(page: Page, target: Locator, pause = 250) {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 28 });
  await sleep(pause);
}
async function click(page: Page, target: Locator) {
  await glide(page, target);
  await target.click();
}
async function typeSlowly(page: Page, target: Locator, text: string) {
  await click(page, target);
  await page.keyboard.type(text, { delay: 38 });
}

/** [start, end] in seconds since the story began: long waits that are sped up in the final video. */
type Wait = [number, number];

async function story(page: Page): Promise<Wait[]> {
  const waits: Wait[] = [];
  const t0 = Date.now();
  const since = () => (Date.now() - t0) / 1000;
  const mark = (m: string) => log(`${((Date.now() - t0) / 1000).toFixed(1)} s  ${m}`);
  // 1. Home → a real chat reply, then "Why this?"
  await page.goto(`${BASE}/?nosplash`);
  await page.evaluate(() => document.fonts.ready);
  await sleep(1800);
  const box = page.getByLabel("Message");
  await typeSlowly(page, box, PROMPTS.home);
  await sleep(500);
  await click(page, page.getByRole("button", { name: "Send" }));
  const chip = page.getByRole("button", { name: /Why this\?/ }).first();
  await chip.waitFor({ timeout: 60_000 });
  mark("home reply shown");
  await sleep(2600); // read the answer
  await click(page, chip);
  await page.getByRole("dialog", { name: "Why this route?" }).waitFor();
  await sleep(5200);
  await page.keyboard.press("Escape");
  await sleep(500);

  // 2. A private chat: stays on this machine
  await click(page, page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "New chat" }));
  // "New chat" from an open thread must really start a new one (the recording once appended to the old thread)
  await page.waitForURL((u) => u.pathname === "/chat" && !u.searchParams.get("t"), { timeout: 5000 });
  await page.getByText("Explain in two sentences why the sky is blue.").waitFor({ state: "detached", timeout: 5000 });
  await click(page, page.getByRole("switch", { name: "Private" }));
  await sleep(600);
  await typeSlowly(page, page.getByLabel("Message"), PROMPTS.private);
  await sleep(400);
  await click(page, page.getByRole("button", { name: "Send" }));
  const waitFrom = since() + 1.5; // the first second and a half always plays at normal speed
  // M4a: local replies usually start at once (ADR 0006). The "sped up" label appears only if the reply is still
  // running after 6 s: only then is the wait cut (below), so the label never claims a speed-up that did not happen.
  await page.evaluate(() => {
    (window as unknown as { __demoFast: number }).__demoFast = window.setTimeout(() => {
      const d = document.createElement("div");
      d.id = "demo-fast";
      d.textContent = "Local model on a 4 GB GPU · sped up";
      d.style.cssText = "position:fixed;z-index:2147483646;right:16px;bottom:64px;padding:6px 12px;border-radius:999px;background:#171a3d;color:#fff;font:600 13px system-ui;opacity:.92";
      document.body.appendChild(d);
    }, 6000);
  });
  await page.getByRole("button", { name: /Why this\?/ }).first().waitFor({ timeout: 120_000 });
  const waitTo = since() - 0.8;
  await page.evaluate(() => {
    window.clearTimeout((window as unknown as { __demoFast: number }).__demoFast);
    document.getElementById("demo-fast")?.remove();
  });
  if (waitTo - waitFrom > 6) waits.push([waitFrom, waitTo]);
  await page.getByText("Private: stays on this computer").first().waitFor();
  mark("private reply done");
  await sleep(4500);

  // 3. Connections (suffixes are masked at the source; assert it so a recording can never leak one)
  await click(page, page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Connections" }));
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.waitForLoadState("networkidle");
  const text = await page.locator("main").innerText();
  const bad = [...text.matchAll(/Key ending (\S+)/g)].filter((m) => m[1] !== "••••");
  if (bad.length) throw new Error(`a real key suffix is on screen: ${bad[0][0]}`);
  mark("connections shown");
  await sleep(2200);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 240);
    await sleep(1000);
  }
  await sleep(600);

  // 4. Rules tester
  await page.goto(`${BASE}/settings/rules?nosplash`);
  await page.getByLabel("Message to test").waitFor();
  await sleep(1200);
  await typeSlowly(page, page.getByLabel("Message to test"), PROMPTS.rules);
  await sleep(400);
  await click(page, page.getByRole("button", { name: "Test routing" }));
  await page.getByRole("region", { name: "Decision" }).waitFor({ timeout: 30_000 });
  mark("rules decision");
  await sleep(4500);
  await page.mouse.wheel(0, 300);
  await sleep(3500);

  // 5. Jobs (M4b, sample data): approve a plan, review the changes per file, the fleet
  await page.goto(`${SAMPLE}/jobs?nosplash`);
  await page.getByRole("heading", { level: 1, name: "Jobs" }).waitFor();
  await sampleLabel(page);
  await sleep(2400);
  await click(page, page.getByRole("list", { name: "Jobs" }).getByRole("link").first());
  await page.getByRole("region", { name: "Approve the plan" }).waitFor();
  await sampleLabel(page);
  mark("job plan");
  await sleep(3800);
  await click(page, page.getByRole("button", { name: "Approve plan" }));
  await sleep(1800);
  await page.goto(`${SAMPLE}/jobs/28?nosplash`);
  await page.getByRole("region", { name: "Changes", exact: true }).waitFor();
  await sampleLabel(page);
  mark("job diff");
  await sleep(2500);
  await page.mouse.wheel(0, 380);
  await sleep(2600);
  await page.mouse.wheel(0, -380);
  await sleep(600);
  await click(page, page.getByRole("button", { name: "Approve and commit" }));
  await sleep(2200);
  await page.goto(`${SAMPLE}/jobs/agents?nosplash`);
  await page.getByRole("region", { name: "Agents" }).waitFor();
  await sampleLabel(page);
  mark("fleet");
  await sleep(2600);
  await click(page, page.getByRole("button", { name: "Hire agent" }));
  await page.getByRole("dialog", { name: "Hire an agent" }).waitFor();
  await sleep(3200);
  await page.keyboard.press("Escape");
  await sleep(1200);
  return waits;
}

function encode(webm: string, waits: Wait[]) {
  const ff = ffmpegPath as unknown as string;
  const mp4 = join(media, "demo.mp4");
  const gif = join(media, "demo.gif");
  const run = (args: string[]) => {
    const r = spawnSync(ff, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
  };
  // Long waits for the local model are sped up (labelled on screen) to about 8 s each, at least 3x;
  // everything else is real time. (How long the local model takes varies from 15 s to over a minute.)
  const speedOf = (a: number, b: number) => Math.max(3, (b - a) / 8);
  const vf = "fps=30,scale=1280:-2:flags=lanczos";
  if (waits.length) {
    const parts: string[] = [];
    let prev = 0;
    const cuts = waits.flatMap(([a, b]) => [[prev, a, 1], [a, (prev = b), speedOf(a, b)]] as [number, number, number][]);
    cuts.push([prev, 9999, 1]);
    cuts.forEach(([a, b, k], i) => parts.push(`[0:v]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/${k}[v${i}]`));
    const fc = `${parts.join(";")};${cuts.map((_, i) => `[v${i}]`).join("")}concat=n=${cuts.length}:v=1:a=0,${vf}[out]`;
    run(["-i", webm, "-filter_complex", fc, "-map", "[out]", "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  } else
  run(["-i", webm, "-vf", vf, "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
  // GIF: shrink until it fits (width, then fps, then palette size)
  const tries: [number, number, number][] = [[800, 10, 128], [720, 10, 96], [640, 8, 96], [560, 8, 64], [480, 6, 64]];
  for (const [w, fps, colors] of tries) {
    run(["-i", mp4, "-vf", `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif]);
    const size = statSync(gif).size;
    log(`gif ${w}px @${fps}fps, ${colors} colours: ${(size / 1048576).toFixed(2)} MB`);
    if (size < LIMIT_GIF * 0.95) return;
  }
  throw new Error("could not get the GIF under 5 MB");
}

async function main() {
  mkdirSync(media, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  await preflight();
  log("starting the demo portal and the sample-data portal (jobs segment)");
  const portal = await startPortal();
  const sample = await startPortal(SAMPLE_PORT, { PORTAL_DATA: "fixture" });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir: tmp, size: { width: W, height: H } },
      reducedMotion: "no-preference",
      colorScheme: "light",
    });
    await ctx.addInitScript(CURSOR);
    await ctx.addInitScript(() => localStorage.setItem("switchboard.prefs.v1", JSON.stringify({ name: "Demo", mode: "simple" })));
    const page = await ctx.newPage();
    const pageAt = Date.now(); // the video starts when the page does
    const waits = await story(page);
    const offset = (Date.now() - pageAt) / 1000;
    log(`story took ${offset.toFixed(1)} s; sped-up waits: ${JSON.stringify(waits)}`);
    const video = page.video()!;
    await ctx.close();
    // story() time starts a moment after the page was created
    encode(await video.path(), waits.map(([a, b]) => [a + 0.4, b + 0.4] as Wait));
    const secs = spawnSync(ffmpegPath as unknown as string, ["-i", join(media, "demo.mp4")], { encoding: "utf8" }).stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (secs) log(`demo.mp4 is ${Number(secs[2]) * 60 + Number(secs[3])} s, ${(statSync(join(media, "demo.mp4")).size / 1048576).toFixed(2)} MB`);
  } finally {
    await browser.close();
    for (const p of [portal, sample]) {
      try {
        process.kill(-p.pid!, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

main().catch((e) => {
  console.error(`[demo] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
