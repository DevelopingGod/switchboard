# Progress

Read this and SPEC.md before starting any work. Update it at the end of every milestone, in the same PR (status table, outcomes, carry-overs).

## Status

| # | Milestone | Status | PR |
|---|---|---|---|
| M0 | Infra: Postgres, LiteLLM, Ollama, Paperclip, doctor | Done | [#1](https://github.com/DevelopingGod/switchboard/pull/1) |
| M0.5 | Design system + app shell | In review | m05 |
| M1 | Connections screen + API + first-run wizard | Not started | |
| M2 | Chat + Router (rules only) | Not started | |
| M3 | Rules UI + Arch-Router classifier | Not started | |
| M4 | Jobs via Paperclip | Not started | |
| M4.5 | Workflow packs | Not started | |
| M5 | Studio (image + video) | Not started | |
| M5.5 | Content Studio | Not started | |
| M6 | Metrics dashboard | Not started | |
| M7 | OSS packaging | Not started | |

## Outcomes

### M0: Infrastructure (done)
Postgres 17 and LiteLLM in Docker, Ollama on Windows reached through `host.docker.internal`, Paperclip native in WSL on `127.0.0.1:3100`, `scripts/doctor.sh`, gitleaks pre-commit hook. Details: [docs/m0.md](m0.md).

### M0.5: Design system and app shell (in review)
- `apps/portal`: Next.js 16 + TypeScript + Tailwind 4 + Radix-based shadcn-style primitives + Motion + Lucide. Package manager is **npm**.
- Direction changed from SPEC's original dark glass to "dreamy sky": Day sky / Dusk themes, one periwinkle accent, Plus Jakarta Sans + Geist. SPEC §8c rewritten to match.
- `design-tokens.ts` is the single source for both themes; CSS variables are generated from it. AA contrast is a unit test over every text/surface pair and sky stop.
- Kit: GlassPanel, PillTabs, Dial, StatCard, RouteChip, ProviderCard, JobCard, CostBadge, ExplainPopover, Composer, Toast, Skeleton, EmptyState (+ StatusBadge, Segmented, Logo, ColumnsArt). Every component has loading / empty / error / disabled states.
- Shell: top pill navigation, mobile bottom bar, ⌘K palette, Simple/Pro switch, Comfortable/Compact density, Appearance menu (theme, solid surfaces, sky image), stub screens for Chat, Studio, Jobs, Connections, Metrics, Settings, and Home with the composer.
- Verification: axe has no serious or critical issues (17 tests: 4 pages x 2 themes, variants, palette, popovers, mobile); Lighthouse (mobile profile) performance 95-98, accessibility 100, best-practices 100 on `/` and `/dev/components` in both themes; initial JS 176-197 KB gzip per route; 34 visual baselines; 12 token/contrast unit tests; 9 shell behavior tests (reduced-transparency and reduced-motion, <= 2 blur layers, Dial keyboard).
- Screenshots: [docs/screens](screens/). Guide: [docs/m05.md](m05.md).

## Carry-overs

- **M1 wizard** must set `name` (read via `usePrefs().name`, currently defaults to "there") and may use `ColumnsArt` for onboarding/login. Login/onboarding screens do not exist yet.
- **Stub screens** (Chat, Studio, Jobs, Connections, Metrics, Settings) are `ScreenStub` placeholders; each later milestone replaces its own.
- **Mobile is read-only** by design (composer disabled with an explanation); revisit if write access on phones is wanted.
- **Ports**: Paperclip owns 3100. Portal dev uses 3000, portal test server 3210.
- **Next.js 16 differences**: the scaffold's `AGENTS.md` says to read `node_modules/next/dist/docs/` before framework work. `cacheComponents` is turned off (client-driven shell, no server data yet); revisit when M1 adds server data fetching.
- **Turbopack CSS layers**: keep custom component CSS in `components.css` (imported with `layer(components)`); `@layer` blocks inside `globals.css` get flattened.
- **Visual baselines are Linux Chromium only.** Regenerate on the same platform; CI in M7 must use the same browser build.
- **Lighthouse under WSL** must run from a scratch cwd (script handles it); the Windows `TEMP` leak otherwise creates `C:\Users\...` directories in the repo.
- **Sky image** is procedurally generated (not AI/photo); swap in a CC0 photo later if a more realistic look is wanted (keep < 150 KB AVIF).
- **Gallery copy** (section titles, sample data) is inline fixture text, not in `strings.ts`.
- **WSL environment quirks** from M0 still apply (NAT/Ollama via Docker, Windows `npm`/`pnpm` on PATH shadow Linux ones, source `~/.nvm/nvm.sh` in tool shells, mount directories not single files in Docker). M1 needs Linux installs of the agent CLIs because Paperclip runs in WSL.
