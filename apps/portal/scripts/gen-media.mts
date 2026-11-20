/**
 * Generates the README's animated SVGs into docs/media: hero-{day,dusk}.svg and routing-{day,dusk}.svg.
 * Colours come from design-tokens.ts (the single source), so the README matches the product.
 *
 * GitHub shows these as <img>: CSS keyframes run, scripts don't, web fonts can't load (system font
 * stack) and every animation is switched off under prefers-reduced-motion (the static frame is the
 * complete picture). Run: npm run gen:media   (output is committed; each file must stay < 60 KB)
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { themes } from "../src/design/design-tokens";

const out = join(import.meta.dirname, "../../../docs/media");
mkdirSync(out, { recursive: true });

const FONT = "'Plus Jakarta Sans','Manrope','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif";
const TAGLINE = ["One calm portal for every AI —", "free tiers, subscriptions and local models, routed for you."];

const stops = (grad: string) => [...grad.matchAll(/(#[0-9a-f]{6})\s+(\d+)%/gi)].map(([, c, p]) => `<stop offset="${p}%" stop-color="${c}"/>`).join("");
const reduce = (css: string) => `@media (prefers-reduced-motion: reduce){${css}}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- hero
function hero(name: "light" | "dark") {
  const t = themes[name];
  const W = 1200;
  const H = 440;
  const fs = 27;
  const lens = TAGLINE.map((s) => r1(s.length * fs * 0.5));
  const lines = TAGLINE.map((s, i) => {
    const y = 328 + i * 44;
    const x0 = r1(W / 2 - lens[i] / 2);
    return { s, y, x0, len: lens[i], clip: `c${i}` };
  });
  const cloud = `<path id="cl" d="M0 60 C0 40 22 32 38 40 C46 14 84 10 98 34 C116 20 150 26 152 52 C176 50 188 70 170 82 L20 82 C4 82 -4 72 0 60Z"/>`;
  const layer = (id: string, y: number, scale: number, op: number, dur: number, delay: number, xs: number[]) =>
    `<g class="drift ${id}" style="animation-duration:${dur}s;animation-delay:${delay}s" opacity="${op}">${xs
      .map((x, i) => `<use href="#cl" transform="translate(${x} ${y + (i % 2) * 14}) scale(${scale})"/>`)
      .join("")}</g>`;
  const dayMode = name === "light";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Switchboard</title>
<desc id="d">${TAGLINE.join(" ")}</desc>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops(t.skyGradient)}</linearGradient>
<radialGradient id="bloomA" cx="14%" cy="8%" r="60%"><stop offset="0" stop-color="${dayMode ? "#fff" : t.accent}" stop-opacity="${dayMode ? 0.8 : 0.3}"/><stop offset="1" stop-color="${dayMode ? "#fff" : t.accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="bloomB" cx="90%" cy="40%" r="50%"><stop offset="0" stop-color="${dayMode ? "#ffd6e8" : "#be78e6"}" stop-opacity="${dayMode ? 0.85 : 0.24}"/><stop offset="1" stop-color="${dayMode ? "#ffd6e8" : "#be78e6"}" stop-opacity="0"/></radialGradient>
<linearGradient id="arc" x1="6" y1="34" x2="36" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${dayMode ? "#6d72de" : "#8b8fe8"}"/><stop offset="1" stop-color="#b3b6fa"/></linearGradient>
${cloud.replace("<path", `<path fill="${dayMode ? "#fff" : "#aaa0ff"}"`)}
${lines.map((l) => `<clipPath id="${l.clip}"><rect class="reveal rv${l.clip}" x="${l.x0}" y="${l.y - 34}" width="${l.len}" height="46"/></clipPath>`).join("\n")}
</defs>
<style>
text{font-family:${FONT}}
.drift{animation-name:drift;animation-timing-function:linear;animation-iteration-count:infinite}
@keyframes drift{from{transform:translateX(-260px)}to{transform:translateX(1500px)}}
.mark{transform-box:fill-box;transform-origin:center;animation:breathe 5.5s ease-in-out infinite}
.halo{transform-box:fill-box;transform-origin:center;animation:halo 5.5s ease-in-out infinite}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
@keyframes halo{0%,100%{opacity:.35;transform:scale(1)}50%{opacity:.8;transform:scale(1.22)}}
.reveal{transform-box:fill-box;transform-origin:0 50%}
.rvc0{animation:type0 15s steps(30,end) infinite}
.rvc1{animation:type1 15s steps(58,end) infinite}
@keyframes type0{0%,4%{transform:scaleX(0)}20%,88%{transform:scaleX(1)}96%,100%{transform:scaleX(0)}}
@keyframes type1{0%,20%{transform:scaleX(0)}48%,88%{transform:scaleX(1)}96%,100%{transform:scaleX(0)}}
.caret{animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
${reduce(".drift,.mark,.halo,.reveal,.caret{animation:none!important}.reveal{transform:none!important}.caret{display:none}")}
</style>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
<rect width="${W}" height="${H}" fill="url(#bloomA)"/>
<rect width="${W}" height="${H}" fill="url(#bloomB)"/>
${layer("far", 40, 1.5, dayMode ? 0.5 : 0.16, 170, -60, [0, 380, 780])}
${layer("mid", 150, 1.1, dayMode ? 0.62 : 0.2, 120, -70, [60, 520, 940])}
${layer("near", 300, 1.9, dayMode ? 0.7 : 0.24, 85, -20, [-40, 430, 860])}
<g transform="translate(${W / 2 - 56} 36) scale(2.8)">
<circle class="halo" cx="20" cy="20" r="17" fill="${t.accent}" opacity=".5"/>
<g class="mark">
<path d="M9.39 30.61A15 15 0 1 1 35 20" fill="none" stroke="url(#arc)" stroke-width="5" stroke-linecap="round"/>
<circle cx="35" cy="20" r="4.4" fill="${t.accent}" stroke="#fff" stroke-width="2"/>
<circle cx="20" cy="20" r="4" fill="${dayMode ? "#171a3d" : "#eef0ff"}"/>
<path d="M20 20 12.5 27.5" stroke="${dayMode ? "#171a3d" : "#eef0ff"}" stroke-width="2.4" stroke-linecap="round"/>
</g></g>
<text x="${W / 2}" y="232" text-anchor="middle" font-size="68" font-weight="800" letter-spacing="-2.5" fill="${t.ink}" textLength="400" lengthAdjust="spacingAndGlyphs">Switchboard</text>
${lines
  .map(
    (l) =>
      `<text clip-path="url(#${l.clip})" x="${l.x0}" y="${l.y}" font-size="${fs}" font-weight="600" fill="${t.ink}" textLength="${l.len}" lengthAdjust="spacingAndGlyphs">${l.s}</text>`,
  )
  .join("\n")}
</svg>
`;
}

// ---------------------------------------------------------------- routing diagram
type Pt = [number, number];
function routing(name: "light" | "dark") {
  const t = themes[name];
  const dayMode = name === "light";
  const W = 1200;
  const H = 380;
  const NW = 200;
  const NH = 78;
  const GAP = 37;
  const X0 = 21;
  const colX = (i: number) => X0 + i * (NW + GAP);
  const rowY = 70;
  const fbY = 238;
  const nodes = [
    { id: "n0", x: colX(0), y: rowY, a: "Your message", b: "or a /slash command" },
    { id: "n1", x: colX(1), y: rowY, a: "Classifier", b: "Arch-Router, on-device" },
    { id: "n2", x: colX(2), y: rowY, a: "Rules", b: "private stays local" },
    { id: "n3", x: colX(3), y: rowY, a: "Quota guard", b: "reroutes at 80% used" },
    { id: "n4", x: colX(4), y: rowY, a: "Model", b: "Groq, Gemini, local…" },
    { id: "fb", x: colX(4), y: fbY, a: "Fallback", b: "next model in the rule" },
  ];
  const mid = (n: { x: number; y: number }): Pt => [n.x + NW / 2, n.y + NH / 2];
  const left = (n: { x: number; y: number }): Pt => [n.x, n.y + NH / 2];
  const right = (n: { x: number; y: number }): Pt => [n.x + NW, n.y + NH / 2];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  // Dot route, shared by both passes: message → classifier → rules → guard, then either the model (pass 1)
  // or, with the guard tripped, the fallback (pass 2). Piecewise linear, so plain CSS keyframes can draw it.
  const head: Pt[] = [mid(byId.n0), mid(byId.n1), mid(byId.n2), mid(byId.n3)];
  const pass1: Pt[] = [...head, mid(byId.n4)];
  const pass2: Pt[] = [...head, [mid(byId.n3)[0], mid(byId.fb)[1] + 0], mid(byId.fb)];
  const T = 18; // seconds per cycle: pass 1 (0–50%), pass 2 (50–100%)
  const seg = 0.085; // share of the cycle per hop
  const track = (pts: Pt[], start: number) => {
    const frames: string[] = [];
    let p = start;
    frames.push(`${r1(p * 100)}%{opacity:0;transform:translate(${pts[0][0]}px,${pts[0][1]}px)}`);
    frames.push(`${r1((p + 0.01) * 100)}%{opacity:1;transform:translate(${pts[0][0]}px,${pts[0][1]}px)}`);
    p += 0.01;
    const times: number[] = [p];
    for (let i = 1; i < pts.length; i++) {
      p += seg;
      frames.push(`${r1(p * 100)}%{opacity:1;transform:translate(${pts[i][0]}px,${pts[i][1]}px)}`);
      times.push(p);
      if (i < pts.length - 1) {
        p += 0.012; // a short beat at each stage
        frames.push(`${r1(p * 100)}%{opacity:1;transform:translate(${pts[i][0]}px,${pts[i][1]}px)}`);
      }
    }
    frames.push(`${r1((p + 0.02) * 100)}%{opacity:0;transform:translate(${pts[pts.length - 1][0]}px,${pts[pts.length - 1][1]}px)}`);
    return { frames, times, end: p };
  };
  const a = track(pass1, 0.0);
  const b = track(pass2, 0.5);
  const dotKeyframes = (k: ReturnType<typeof track>, nm: string) => `@keyframes ${nm}{${k.frames.join("")}}`;
  // A node glows while the dot is on it.
  const glow = (nm: string, at: number[]) => {
    const f = at.flatMap((x) => [`${r1((x - 0.012) * 100)}%{opacity:0}`, `${r1(x * 100)}%{opacity:1}`, `${r1((x + 0.07) * 100)}%{opacity:0}`]);
    return `@keyframes ${nm}{0%{opacity:0}${f.join("")}100%{opacity:0}}`;
  };
  const stageTimes = (k: ReturnType<typeof track>) => k.times;
  const glowFor: Record<string, number[]> = {
    n0: [a.times[0], b.times[0]],
    n1: [a.times[1], b.times[1]],
    n2: [a.times[2], b.times[2]],
    n3: [a.times[3], b.times[3]],
    n4: [a.times[4]],
    fb: [b.times[4]],
  };
  void stageTimes;
  const warnAt = b.times[3]; // the guard trips on pass 2
  const conn = (p: Pt, q: Pt, cls = "", dash = "") => `<path class="wire ${cls}" d="M${p[0]} ${p[1]}L${q[0]} ${q[1]}" ${dash}/>`;
  const wires = [
    conn(right(byId.n0), left(byId.n1)),
    conn(right(byId.n1), left(byId.n2)),
    conn(right(byId.n2), left(byId.n3)),
    conn(right(byId.n3), left(byId.n4)),
    `<path class="wire fbwire" d="M${mid(byId.n3)[0]} ${byId.n3.y + NH}C${mid(byId.n3)[0]} ${fbY - 40} ${left(byId.fb)[0] - 20} ${mid(byId.fb)[1]} ${left(byId.fb)[0]} ${mid(byId.fb)[1]}"/>`,
  ].join("\n");
  // Agents and jobs: a dashed side path, because a job only starts when you confirm "Run as job" (M4b).
  const agentX = colX(2);
  const agent = `<g class="soon"><rect x="${agentX}" y="${fbY}" width="${NW}" height="${NH}" rx="18" fill="none" stroke="${t.inkMuted}" stroke-dasharray="6 6" stroke-width="1.5"/>
<text x="${agentX + NW / 2}" y="${fbY + 33}" text-anchor="middle" font-size="19" font-weight="700" fill="${t.inkMuted}">Agent or job</text>
<text x="${agentX + NW / 2}" y="${fbY + 56}" text-anchor="middle" font-size="13" fill="${t.inkMuted}">when you confirm</text></g>
<path d="M${mid(byId.n2)[0]} ${rowY + NH}V${fbY}" stroke="${t.inkMuted}" stroke-width="1.5" stroke-dasharray="3 6" fill="none"/>`;
  const nodeSvg = nodes
    .map(
      (n) => `<g>
<rect x="${n.x}" y="${n.y}" width="${NW}" height="${NH}" rx="18" fill="${t.glassStrong}" stroke="${t.hairline}" stroke-width="1.5"/>
<rect class="g ${n.id}" x="${n.x - 3}" y="${n.y - 3}" width="${NW + 6}" height="${NH + 6}" rx="21" fill="none" stroke="${n.id === "fb" ? t.ok : t.accentStrong}" stroke-width="3"/>
<text x="${n.x + NW / 2}" y="${n.y + 33}" text-anchor="middle" font-size="20" font-weight="700" fill="${t.ink}">${n.a}</text>
<text x="${n.x + NW / 2}" y="${n.y + 57}" text-anchor="middle" font-size="13.5" fill="${t.inkMuted}">${n.b}</text></g>`,
    )
    .join("\n");
  const css = `text{font-family:${FONT}}
.wire{fill:none;stroke:${t.accentStrong};stroke-opacity:.45;stroke-width:2.5;stroke-linecap:round}
.fbwire{stroke:${t.ok};stroke-opacity:.9;stroke-dasharray:7 7}
.g{opacity:0}
.dot{opacity:0}
.dot.d1{animation:d1 ${T}s linear infinite}
.dot.d2{animation:d2 ${T}s linear infinite}
${dotKeyframes(a, "d1")}
${dotKeyframes(b, "d2")}
${Object.entries(glowFor)
  .map(([id, at]) => `.${id}{animation:g_${id} ${T}s linear infinite}${glow("g_" + id, at)}`)
  .join("\n")}
.warn{opacity:0;animation:warn ${T}s linear infinite}
@keyframes warn{0%,${r1((warnAt - 0.02) * 100)}%{opacity:0}${r1(warnAt * 100)}%,${r1((warnAt + 0.1) * 100)}%{opacity:1}${r1((warnAt + 0.14) * 100)}%,100%{opacity:0}}
${reduce(`.dot{display:none}.g,.warn{animation:none!important}.warn{opacity:1}.fb{opacity:1}`)}`;
  const warnX = mid(byId.n3)[0] + 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">How Switchboard routes a message</title>
<desc id="d">A message goes to the classifier, then the rules, then the quota guard, then a model. When the quota guard sees a free limit about 80 percent used, or a model is rate-limited, the message goes to the fallback instead. Agents and jobs run through the API today; their page arrives in milestone 4b.</desc>
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops(t.skyGradient)}</linearGradient></defs>
<style>${css}</style>
<rect width="${W}" height="${H}" rx="28" fill="url(#sky)"/>
${wires}
${agent}
${nodeSvg}
<g class="warn"><text x="${warnX}" y="${(byId.n3.y + NH + fbY) / 2 - 6}" font-size="14" font-weight="700" fill="${t.warn}">80% used or 429</text>
<text x="${warnX}" y="${(byId.n3.y + NH + fbY) / 2 + 12}" font-size="13" fill="${t.inkMuted}">so it moves on</text></g>
<circle class="dot d1" r="9" fill="${t.accent}" stroke="${dayMode ? "#fff" : "#eef0ff"}" stroke-width="3"/>
<circle class="dot d2" r="9" fill="${t.accent}" stroke="${dayMode ? "#fff" : "#eef0ff"}" stroke-width="3"/>
<text x="${W / 2}" y="${H - 18}" text-anchor="middle" font-size="14" fill="${t.inkMuted}">Every hop is logged. “Why this?” shows the rule, the score, and what was skipped and why.</text>
</svg>
`;
}

const files: [string, string][] = [
  ["hero-day.svg", hero("light")],
  ["hero-dusk.svg", hero("dark")],
  ["routing-day.svg", routing("light")],
  ["routing-dusk.svg", routing("dark")],
];
for (const [f, body] of files) {
  writeFileSync(join(out, f), body);
  const kb = statSync(join(out, f)).size / 1024;
  console.log(`${f}  ${kb.toFixed(1)} KB`);
  if (kb >= 60) throw new Error(`${f} must stay under 60 KB`);
}
void readFileSync;
