# 0005. README media (animated SVG + GIF), a throwaway demo stack, one project version, and Motion on demand

Status: accepted (2026-11-20)

## Context
GitHub renders a README with no JavaScript or CSS of our own, and a repo-relative `<video>` does not play inline.
The README must be eye-catching but true, the demo must show real replies without exposing the owner's chats
or key suffixes, and the version was in three places that disagreed (router 0.4.0, portal 0.1.5, fixtures 0.1.5).
Separately, Motion (~19 KB gzip) was in every route's first load for the toast and one gallery component.

## Options
1. **Media.** (a) Animated SVG used as `<img>` (CSS keyframes run, scripts don't) plus a GIF that links to the MP4;
   (b) a GitHub Pages site with a real player; (c) an external video host. (a) works today with no new hosting;
   (b) is a good M7 follow-up (recorded in PROGRESS Future); (c) sends viewers to a third party.
2. **Demo data.** (a) Fixtures: reproducible, but the replies are canned; (b) the owner's live stack: real, but shows
   their chats and key suffixes; (c) a separate "Demo" database and router: real replies, none of the owner's data.
3. **Version.** (a) Keep three copies and remember; (b) one root `VERSION` file read by the router and checked in CI-style
   by `scripts/check-docs.mjs` for every other copy.
4. **Motion.** (a) Keep it in the shell; (b) replace the toast and PillTabs animations with CSS (a visible design change);
   (c) load it with the first toast or PillTabs, same animations.

## Decision
- 1a: `docs/media/hero-*.svg` and `routing-*.svg` are generated from the design tokens (`npm run gen:media`), every
  animation is off under `prefers-reduced-motion`, and each file stays < 60 KB. The demo is a GIF (< 5 MB) that links to
  `demo.mp4`. No fake player.
- 2c: `scripts/demo-stack.sh` creates `switchboard_demo` (schema from migrations; only connection rows, "key saved"
  markers with a dummy ciphertext and a masked suffix, the model catalog and a few settings rows are copied; no
  threads, messages, requests, costs or keys) and one extra router container. That router sets
  `ROUTER_SYNC_ENABLED=false` (it never writes to LiteLLM or refreshes the catalog; only the main router does) and
  `ROUTER_REQUEST_TAG=switchboard-demo` (LiteLLM calls and `requests` rows carry it so Metrics can exclude them).
  The real stack is never stopped or read for chats.
- 3b: root `VERSION`; the router image gets it through a compose `additional_contexts` entry (the build context
  stays `services/router`); the footer already shows the router's version.
- 4c: `MotionScope` wraps only the toast viewport and PillTabs; same animations, loaded on first use.

## Consequences
- Every route's first-load JS dropped by 12 to 18 KB (worst route now 191.6 KB, the dev gallery), restoring the headroom M4 needs.
- Smaller bundles changed hydration timing and exposed an existing race: the chat scrolled to the newest message, then
  lazy Markdown changed heights above it (a visible jump, CLS up to 0.09 under load). The thread now stays pinned to the
  end until the reader scrolls, and two visual baselines that had captured the race's outcome were regenerated.
- The demo needs a running Ollama for the private segment, and the local model's speed varies (15 s to over a minute
  on a 4 GB GPU), so long waits are sped up and labelled on screen.
- `ffmpeg-static` (pinned, dev only) is the only new dependency; it downloads an ffmpeg binary on install.
