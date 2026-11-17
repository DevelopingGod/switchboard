/**
 * Procedurally paints the optional sky images (original artwork, no third-party assets).
 * Layered gradients + fractal-noise clouds, rendered with sharp and encoded as AVIF.
 * Run: npm run gen:sky   (output is committed; each file must stay under 150 KB)
 */
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const W = 1920;
const H = 1080;
const out = join(import.meta.dirname, "../public/sky");

interface Palette {
  stops: [number, string][];
  cloudColor: string;
  cloudAlpha: number;
  blooms: { cx: number; cy: number; r: number; color: string }[];
  seed: number;
}

const day: Palette = {
  stops: [[0, "#9ccbff"], [0.34, "#cdd0ff"], [0.64, "#f5c9ec"], [1, "#ffd5bd"]],
  cloudColor: "255 255 255",
  cloudAlpha: 0.95,
  blooms: [
    { cx: 0.14, cy: 0.08, r: 0.5, color: "rgba(255,255,255,0.75)" },
    { cx: 0.92, cy: 0.34, r: 0.42, color: "rgba(255,206,230,0.8)" },
  ],
  seed: 7,
};
const dusk: Palette = {
  stops: [[0, "#0b0c2b"], [0.48, "#1d1654"], [1, "#43288e"]],
  cloudColor: "150 140 255",
  cloudAlpha: 0.32,
  blooms: [
    { cx: 0.16, cy: 0.06, r: 0.5, color: "rgba(139,143,232,0.3)" },
    { cx: 0.9, cy: 0.42, r: 0.42, color: "rgba(196,120,232,0.24)" },
  ],
  seed: 21,
};

function svg(p: Palette) {
  const [r, g, b] = p.cloudColor.split(" ").map((n) => Number(n) / 255);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      ${p.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}
    </linearGradient>
    ${p.blooms
      .map(
        (m, i) => `<radialGradient id="b${i}" cx="${m.cx}" cy="${m.cy}" r="${m.r}">
      <stop offset="0" stop-color="${m.color}"/><stop offset="1" stop-color="${m.color.replace(/[\d.]+\)$/, "0)")}"/></radialGradient>`,
      )
      .join("")}
    <filter id="clouds" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.0028 0.0075" numOctaves="5" seed="${p.seed}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  ${p.cloudAlpha * 3.2} 0 0 0 ${-p.cloudAlpha * 1.35}"/>
      <feGaussianBlur stdDeviation="14"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${p.blooms.map((_, i) => `<rect width="${W}" height="${H}" fill="url(#b${i})"/>`).join("")}
  <rect width="${W}" height="${H}" filter="url(#clouds)"/>
</svg>`;
}

mkdirSync(out, { recursive: true });
for (const [name, pal] of [["day", day], ["dusk", dusk]] as const) {
  const file = join(out, `${name}.avif`);
  await sharp(Buffer.from(svg(pal))).avif({ quality: 42, effort: 6 }).toFile(file);
  console.log(`${name}.avif ${(statSync(file).size / 1024).toFixed(1)} KB`);
}
