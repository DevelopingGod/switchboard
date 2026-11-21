# 0011. Metrics charts are hand-rolled SVG, not a chart library

Status: accepted (2026-11-21, M6).

## Context
SPEC §5 names Recharts for the portal's charts. M6 needs a handful of simple forms: grouped bars (spend vs value),
stacked bars (429s, timeouts, failed requests), two lines (p50/p95 latency), dials (already in the kit) and tables.
The hard limits (CLAUDE.md principle 7) are ≤ 200 KB first-load JS per route, Lighthouse ≥ 90, axe clean and
CLS < 0.05, and every chart must work without colour (labels, table fallback) in both themes.

## Options
1. **Recharts** (SPEC's pick). Full-featured and accessible enough with work.
   - *Against:* ~100 KB gzip with its d3 dependencies. `/metrics` would land near or over the budget, and Turbopack
     ships modules whole (PROGRESS, M2 notes), so the cost isn't trimmed by using few chart types.
2. **uPlot** (~20 KB). Fast for large time series.
   - *Against:* draws on canvas: no DOM for screen readers or axe, tooltips and labels are custom work anyway, and
     our series are at most 30 points.
3. **Hand-rolled SVG** (recommended). Three components (`BarChart`, `LineChart`, `DataTable`) in
   `components/metrics/charts.tsx`, ~5 KB gzip.
   - *For:* real DOM (`<figure>`, `role="img"` with a summary, `<figcaption>`, legend), CSS variables for both
     themes, hatch textures and dashes so no series depends on colour, the same numbers as a `<table>` with CSV
     export, and nothing new to pin or audit.
   - *Against:* we own axis ticks, tooltips and edge cases (empty slots, gaps). Covered by unit tests (`ticks`,
     formatting) and Playwright (table view, hover, export).

## Decision
Option 3. The categorical colours are the dataviz reference slots (blue, orange, aqua, yellow), validated on the
portal's opaque chart surface in each theme (`#fbfbff` Day, `#1a1850` Dusk): all checks pass; on Day two slots
are under 3:1 against the surface, so the relief rule applies, which the legend, textures and table view provide.
Charts sit on that opaque surface (`.viz-surface`), never on glass, so contrast never depends on the sky. Forced
colours mode maps the slots to system colours.

## Consequences
- `/metrics` first load is 171.7 KB gzip; the Pro sections are a separate lazy chunk.
- SPEC §5's "Recharts" is replaced by "hand-rolled SVG charts (ADR 0011)".
- A future chart form (scatter, heatmap) is added as one more small component, or this ADR is revisited if the
  needs outgrow a few hundred lines.
