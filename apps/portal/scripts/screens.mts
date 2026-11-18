/**
 * Full-page screenshots into docs/screens/: / and /dev/components (both themes, CSS sky and sky image),
 * plus Connections, Chat and each wizard step (both themes, CSS sky). Chat extras: the "Why this?"
 * popover on a fallback reply, and a private reply with its thinking expanded (sends one fixture
 * message, so restart the fixture server before running the Playwright suite again).
 * Needs a production server on fixture data: npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3210
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";

const BASE = process.env.PORTAL_URL ?? "http://127.0.0.1:3210";
const out = join(import.meta.dirname, "../../../docs/screens");
mkdirSync(out, { recursive: true });

const withSky = { "": "css", "-sky": "image" } as const;
const cssOnly = { "": "css" } as const;
const SEED = "6f1c2a10-0000-4000-8000-000000000001";
type Clip = { x: number; y: number; width: number; height: number };
const pages: Record<string, { path: string; skies: Record<string, string>; act?: (p: Page) => Promise<void>; clip?: (p: Page) => Promise<Clip>; viewport?: boolean }> = {
  home: { path: "/", skies: withSky },
  components: { path: "/dev/components", skies: withSky },
  connections: { path: "/connections", skies: cssOnly },
  chat: { path: `/chat?t=${SEED}`, skies: cssOnly },
  "chat-why": {
    path: `/chat?t=${SEED}`,
    skies: cssOnly,
    act: async (p) => {
      await p.getByRole("button", { name: /Why this\? Routed to Google AI Studio/ }).click();
      await p.getByRole("dialog", { name: "Why this route?" }).waitFor();
    },
  },
  // M1.5
  "chat-hover": {
    path: `/chat?t=${SEED}`,
    skies: cssOnly,
    viewport: true,
    act: async (p) => {
      await p.evaluate(() => window.scrollTo(0, 260));
      await p.getByRole("article", { name: "Assistant" }).nth(1).hover();
    },
  },
  settings: { path: "/settings", skies: cssOnly },
  status: { path: "/status", skies: cssOnly },
  footer: {
    path: "/jobs",
    skies: cssOnly,
    clip: async (p) => {
      const b = (await p.getByRole("contentinfo", { name: "Status and links" }).boundingBox())!;
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      return { x: 0, y: b.y - 16, width: 1440, height: Math.min(b.height + 32, h - (b.y - 16)) };
    },
  },
  tooltip: {
    path: "/jobs",
    skies: cssOnly,
    viewport: true,
    act: async (p) => {
      await p.waitForFunction(() => !!document.getElementById("sb-tip"));
      await p.getByRole("link", { name: "Settings" }).first().hover();
      await p.waitForSelector("#sb-tip[data-state=open]");
    },
    clip: async () => ({ x: 1040, y: 0, width: 400, height: 160 }),
  },
  shortcuts: { path: "/jobs", skies: cssOnly, viewport: true, act: async (p) => p.keyboard.press("?") },
  splash: {
    path: "/jobs",
    skies: cssOnly,
    viewport: true,
    act: async (p) => {
      // The splash shows once per session and never under reduced motion: freeze it here.
      await p.addStyleTag({ content: "#sb-splash{animation:none!important} #sb-splash .splash-mark{animation:none!important}" });
      await p.evaluate(() => document.documentElement.setAttribute("data-splash", ""));
    },
  },
  "chat-private": {
    path: "/chat",
    skies: cssOnly,
    act: async (p) => {
      await p.getByRole("switch", { name: "Private" }).click();
      await p.getByLabel("Message").fill("Summarise my health notes from this morning");
      await p.getByLabel("Message").press("Enter");
      await p.getByRole("button", { name: /Thought for/ }).click();
      await p.getByRole("button", { name: /Routed to Ollama/ }).waitFor();
    },
  },
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`welcome-${n}`, { path: `/welcome?step=${n}`, skies: cssOnly }])),
};
const themes = { day: "light", dusk: "dark" } as const;

const browser = await chromium.launch();
const only = process.argv.slice(2);
for (const [pname, { path, skies, act, clip, viewport }] of Object.entries(pages)) {
  if (only.length && !only.includes(pname)) continue;
  for (const [tname, theme] of Object.entries(themes)) {
    for (const [suffix, sky] of Object.entries(skies)) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(`${BASE}${path}${path.includes("?") ? "&" : "?"}theme=${theme}&sky=${sky}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      await act?.(page);
      if (!viewport) {
        // <main> is at least one viewport tall (keeps the footer below the fold while loading); with the
        // viewport grown to the page height that would push the footer out of the shot, so lift it here.
        await page.addStyleTag({ content: "main#main{min-height:0!important}" });
        // The sky is position:fixed, so grow the viewport to the page height for a seamless backdrop.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: 1440, height });
      }
      await page.waitForTimeout(300);
      const file = join(out, `${pname}-${tname}${suffix}.webp`);
      // WebP keeps the committed screenshots small (the gradients make PNGs 3–4 MB).
      await sharp(await page.screenshot(clip ? { clip: await clip(page) } : {})).webp({ quality: 88 }).toFile(file);
      console.log(file);
      await ctx.close();
    }
  }
}
await browser.close();
