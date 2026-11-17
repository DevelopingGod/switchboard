import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCss, themes, type ThemeName, type ThemeTokens } from "./design-tokens";

type RGBA = [number, number, number, number];

function parse(c: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) throw new Error(`cannot parse ${c}`);
  const [r, g, b, a = "1"] = m[1].split(",").map((s) => s.trim());
  return [+r, +g, +b, +a];
}

const over = (fg: RGBA, bg: RGBA): RGBA => {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1) as RGBA;
};

const lum = ([r, g, b]: RGBA) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

export function contrast(fg: RGBA, bg: RGBA): number {
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every colour stop of the sky gradient, the worst-case backgrounds panels can sit on. */
const skyStops = (t: ThemeTokens) => [...t.skyGradient.matchAll(/#[0-9a-f]{6}/gi)].map((m) => parse(m[0]));

const AA = 4.5;

describe.each(Object.keys(themes) as ThemeName[])("%s theme contrast (WCAG AA)", (name) => {
  const t = themes[name];
  const textOnStrong = ["ink", "inkMuted", "accentStrong", "ok", "warn", "err"] as const;

  it("status/body text meets 4.5:1 on near-opaque surfaces over every sky stop", () => {
    for (const sky of skyStops(t)) {
      const strong = over(parse(t.glassStrong), sky);
      for (const k of textOnStrong) expect(contrast(parse(t[k]), strong), `${k} on glassStrong`).toBeGreaterThanOrEqual(AA);
    }
    for (const k of textOnStrong) expect(contrast(parse(t[k]), parse(t.surfaceSolid)), `${k} on solid`).toBeGreaterThanOrEqual(AA);
  });

  it("ink and muted ink meet 4.5:1 on glass containers and on the bare sky", () => {
    for (const sky of skyStops(t)) {
      const glass = over(parse(t.glass), sky);
      for (const k of ["ink", "inkMuted"] as const) {
        expect(contrast(parse(t[k]), glass), `${k} on glass`).toBeGreaterThanOrEqual(AA);
        expect(contrast(parse(t[k]), sky), `${k} on sky`).toBeGreaterThanOrEqual(AA);
      }
      const pill = over(parse(t.pillActive), glass);
      expect(contrast(parse(t.ink), pill), "ink on active pill").toBeGreaterThanOrEqual(AA);
    }
  });

  it("text on the periwinkle primary action meets 4.5:1", () => {
    expect(contrast(parse(t.onAccent), parse(t.accent))).toBeGreaterThanOrEqual(AA);
  });

  it("code panels meet 7:1", () => {
    expect(contrast(parse(t.solidInk), parse(t.solid))).toBeGreaterThanOrEqual(7);
  });

  it("focus ring and dial arc meet 3:1 against surfaces", () => {
    for (const sky of skyStops(t)) {
      const strong = over(parse(t.glassStrong), sky);
      expect(contrast(parse(t.focus), strong)).toBeGreaterThanOrEqual(3);
      expect(contrast(parse(t.accentStrong), strong)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("generated artefacts", () => {
  it("tokens.generated.css matches design-tokens.ts (run `npm run gen:tokens`)", () => {
    const file = readFileSync(join(__dirname, "tokens.generated.css"), "utf8");
    expect(file).toBe(buildCss());
  });

  it("optional sky images stay under 150 KB", () => {
    for (const f of ["day", "dusk"]) {
      expect(statSync(join(__dirname, `../../public/sky/${f}.avif`)).size).toBeLessThan(150 * 1024);
    }
  });
});
