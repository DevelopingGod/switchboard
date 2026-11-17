/**
 * Single source of truth for the Switchboard design system (SPEC §8c).
 * `scripts/gen-tokens.ts` emits these as CSS variables into tokens.generated.css;
 * a vitest test fails if that file drifts or if any text/surface pair drops below WCAG AA.
 */

export type ThemeName = "light" | "dark";

export interface ThemeTokens {
  /** Page backdrop. */
  skyGradient: string;
  skyBloomA: string;
  skyBloomB: string;
  cloud: string;
  /** Translucent container fill (no body text directly on it without `ink*` contrast being met). */
  glass: string;
  /** Near-opaque fill for anything that carries text. */
  glassStrong: string;
  /** Fully opaque fallback used by reduced-transparency / solid-surfaces mode. */
  surfaceSolid: string;
  glassBorder: string;
  hairline: string;
  ink: string;
  inkMuted: string;
  accent: string;
  /** Accent for text, arcs and icons on glass (AA on glass surfaces). */
  accentStrong: string;
  accentSoft: string;
  onAccent: string;
  pillActive: string;
  ok: string;
  warn: string;
  err: string;
  /** Code, diffs and logs live on solid panels. */
  solid: string;
  solidInk: string;
  track: string;
  focus: string;
  shadowGlass: string;
  shadowPop: string;
  /** Thin themed scrollbars (M1.5): thumb at rest and on hover/drag; both ≥ 3:1 on surfaces. */
  scrollThumb: string;
  scrollThumbHover: string;
  /** Ambient cursor (M1.5): the soft pointer glow and the lit edge of glass cards. */
  cursorGlow: string;
  cursorEdge: string;
}

export const themes: Record<ThemeName, ThemeTokens> = {
  // "Day sky": peach, pink, sky blue, lavender.
  light: {
    skyGradient:
      "linear-gradient(180deg, #a9d4ff 0%, #cfd3ff 34%, #f3cdee 64%, #ffd9c2 100%)",
    skyBloomA: "radial-gradient(60% 50% at 14% 8%, rgba(255,255,255,0.8), transparent 70%)",
    skyBloomB: "radial-gradient(50% 42% at 92% 32%, rgba(255,214,232,0.85), transparent 70%)",
    cloud: "rgba(255,255,255,0.6)",
    glass: "rgba(255,255,255,0.58)",
    glassStrong: "rgba(255,255,255,0.92)",
    surfaceSolid: "#fbfbff",
    glassBorder: "rgba(255,255,255,0.8)",
    hairline: "rgba(40,44,100,0.14)",
    ink: "#171a3d",
    inkMuted: "#4a4f78",
    accent: "#8b8fe8",
    accentStrong: "#4b50c4",
    accentSoft: "rgba(139,143,232,0.2)",
    onAccent: "#12143a",
    pillActive: "#ffffff",
    ok: "#17693f",
    warn: "#7a4f00",
    err: "#a8231b",
    solid: "#14163a",
    solidInk: "#e8eaff",
    track: "rgba(40,44,100,0.16)",
    focus: "#4b50c4",
    shadowGlass: "0 12px 40px -14px rgba(70,70,160,0.32), inset 0 1px 0 rgba(255,255,255,0.8)",
    shadowPop: "0 18px 56px -16px rgba(50,50,140,0.45)",
    scrollThumb: "rgba(40,44,100,0.54)",
    scrollThumbHover: "rgba(40,44,100,0.7)",
    cursorGlow: "rgba(139,143,232,0.22)",
    cursorEdge: "rgba(110,115,226,0.7)",
  },
  // "Dusk": deep indigo to violet.
  dark: {
    skyGradient:
      "linear-gradient(180deg, #0d0e2e 0%, #1d1654 48%, #3a2480 100%)",
    skyBloomA: "radial-gradient(55% 45% at 16% 6%, rgba(139,143,232,0.28), transparent 70%)",
    skyBloomB: "radial-gradient(50% 42% at 90% 40%, rgba(190,120,230,0.22), transparent 70%)",
    cloud: "rgba(170,160,255,0.10)",
    glass: "rgba(30,28,84,0.52)",
    glassStrong: "rgba(22,20,64,0.92)",
    surfaceSolid: "#1a1850",
    glassBorder: "rgba(190,190,255,0.2)",
    hairline: "rgba(190,190,255,0.16)",
    ink: "#eef0ff",
    inkMuted: "#b9bdee",
    accent: "#8b8fe8",
    accentStrong: "#b3b6fa",
    accentSoft: "rgba(139,143,232,0.26)",
    onAccent: "#12143a",
    pillActive: "rgba(139,143,232,0.32)",
    ok: "#6fe3a4",
    warn: "#ffc766",
    err: "#ff9a92",
    solid: "#0b0c24",
    solidInk: "#e8eaff",
    track: "rgba(190,190,255,0.2)",
    focus: "#b3b6fa",
    shadowGlass: "0 14px 44px -14px rgba(0,0,20,0.6), inset 0 1px 0 rgba(255,255,255,0.08)",
    shadowPop: "0 20px 60px -16px rgba(0,0,30,0.75)",
    scrollThumb: "rgba(200,200,255,0.5)",
    scrollThumbHover: "rgba(200,200,255,0.7)",
    cursorGlow: "rgba(139,143,232,0.26)",
    cursorEdge: "rgba(179,182,250,0.75)",
  },
};

/** Theme-independent tokens. */
export const shared = {
  /** At most two stacked blur layers anywhere on screen. */
  blur: { one: "14px", two: "24px" },
  radius: { chip: "999px", control: "14px", panel: "20px", hero: "28px" },
  /**
   * Motion system v2 (M1.5). Every UI transition is 150–300 ms on transform/opacity only, and all of
   * it is off under prefers-reduced-motion or the Motion → Reduce setting. Ambient loops (clouds,
   * breathing dots) are the only longer durations.
   */
  motion: {
    fast: "150ms",
    base: "200ms",
    slow: "250ms",
    /** Page and list entrances. */
    enter: "220ms",
    /** Exits are quicker than entrances. */
    exit: "150ms",
    /** Delay between list items in a stagger (at most 8 items are staggered). */
    stagger: "30ms",
    /** CSS approximation of a spring (slight overshoot): presses, pops. */
    ease: "cubic-bezier(0.34, 1.4, 0.64, 1)",
    /** Decelerate: things arriving. */
    easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
    /** Accelerate: things leaving. */
    easeIn: "cubic-bezier(0.4, 0, 1, 1)",
    cloudDrift: "90s",
    breathe: "3.2s",
  },
  /** Spring presets for Motion (motion/react); they settle in about 200–300 ms. */
  spring: { stiffness: 520, damping: 34, mass: 0.8 },
  springs: {
    snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.8 },
    gentle: { type: "spring", stiffness: 300, damping: 30, mass: 0.9 },
  },
  density: {
    comfortable: { pad: "20px", gap: "16px", row: "52px", ctl: "44px" },
    compact: { pad: "12px", gap: "10px", row: "38px", ctl: "36px" },
  },
  font: {
    display: "var(--font-display)",
    ui: "var(--font-ui)",
    mono: "var(--font-mono)",
  },
} as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function declarations(obj: Record<string, string>, prefix = "--"): string {
  return Object.entries(obj)
    .map(([k, v]) => `  ${prefix}${kebab(k)}: ${v};`)
    .join("\n");
}

/** Full text of tokens.generated.css. */
export function buildCss(): string {
  const { blur, radius, motion, density } = shared;
  const common = declarations({
    blur1: blur.one,
    blur2: blur.two,
    backdrop1: `blur(${blur.one}) saturate(1.3)`,
    backdrop2: `blur(${blur.two}) saturate(1.3)`,
    radiusChip: radius.chip,
    radiusControl: radius.control,
    radiusPanel: radius.panel,
    radiusHero: radius.hero,
    dFast: motion.fast,
    dBase: motion.base,
    dSlow: motion.slow,
    ease: motion.ease,
    easeOut: motion.easeOut,
    easeIn: motion.easeIn,
    dEnter: motion.enter,
    dExit: motion.exit,
    stagger: motion.stagger,
    cloudDrift: motion.cloudDrift,
    breathe: motion.breathe,
    pad: density.comfortable.pad,
    gap: density.comfortable.gap,
    row: density.comfortable.row,
    ctl: density.comfortable.ctl,
  });
  const compact = declarations({
    pad: density.compact.pad,
    gap: density.compact.gap,
    row: density.compact.row,
    ctl: density.compact.ctl,
  });
  const solidify = [
    "  --glass: var(--surface-solid);",
    "  --glass-strong: var(--surface-solid);",
    "  --backdrop1: none;",
    "  --backdrop2: none;",
  ].join("\n");

  return `/* GENERATED by scripts/gen-tokens.ts from src/design/design-tokens.ts. Do not edit. */
:root {
  color-scheme: light;
${declarations(themes.light as unknown as Record<string, string>)}
${common}
}

:root[data-theme="dark"] {
  color-scheme: dark;
${declarations(themes.dark as unknown as Record<string, string>)}
}

:root[data-density="compact"] {
${compact}
}

/* Solid fallback: OS preference or the manual "Solid surfaces" switch. */
@media (prefers-reduced-transparency: reduce) {
  :root[data-theme] {
${solidify.replace(/^ {2}/gm, "    ")}
  }
}
:root[data-surfaces="solid"] {
${solidify}
}
`;
}
