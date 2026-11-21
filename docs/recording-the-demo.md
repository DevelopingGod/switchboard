# Recording the README demo

The demo in the README (`docs/media/demo.gif` and `demo.mp4`) is recorded by a script against a **throwaway Demo
stack**: a separate database and one extra router, so none of your chats, titles or key suffixes can appear. Real
replies from your real providers and your local model. Decisions: [ADR 0005](adr/0005-readme-media-and-single-version.md).

## Re-record

Your normal stack must be running (Postgres, LiteLLM, your main router) and **Ollama must be running** (the private
segment needs it). From the repo root, in an Ubuntu terminal:

```bash
scripts/demo-stack.sh reset
```

```bash
cd apps/portal && npm run build && npm run demo:record
```

```bash
cd ../.. && scripts/demo-stack.sh down
```

`reset` creates `switchboard_demo` (and drops any previous one), copies only connection rows, "key saved" markers (a
dummy value, never a key, with the suffix shown as `••••`), the model catalog and a few settings, names the profile
"Demo", and starts `switchboard-demo-router` on `127.0.0.1:8110`. `npm run demo:record` starts a production portal on
`127.0.0.1:3220` pointed at it, records the storyboard with Playwright (1280×720), and writes
`docs/media/demo.mp4` (H.264) and `docs/media/demo.gif` (< 5 MB; it shrinks width, frame rate and colours until it fits).
`down` removes the demo router and drops the demo database. **Your real stack is never stopped or written to.**

## Storyboard (about 95 s)

Home → a real reply → **Why this?** → New chat → **Private** → a real local reply → Connections (suffixes shown as
dots) → Rules tester → **Jobs** (sample data): the board, a plan to approve, the changes per file, Approve and commit →
**Agents** and the Hire agent dialog → **Metrics** (sample data): Simple numbers and insights, then Pro quotas and
budgets.

The jobs segment runs on a second portal on `127.0.0.1:3221` with fixture data (`PORTAL_DATA=fixture`), labelled
"Sample data · jobs run on your own repos" on screen. A real job through the Demo stack is not recorded: the demo
database numbers jobs from 1, and job branches (`switchboard/job-<n>`) and Paperclip issue keys would collide with your
real jobs in the shared Paperclip company and project (M4b decision; docs/m4b.md). Edit `PROMPTS` and `story()` in `apps/portal/scripts/record-demo.mts`. Keep prompts harmless:
nothing personal, health or financial.

## Things to know

- **The local model's speed varies** (15 s to over a minute on a 4 GB GPU). Waits longer than 6 s are sped up to about
  8 s in the final video, with an on-screen label ("Local model on a 4 GB GPU · sped up"). Warm the model first
  (`ollama run qwen3:4b hi`) for steadier timing.
- **No real key suffix can be recorded:** the demo database only holds `••••`, and the script stops if a suffix other than
  `••••` is on the Connections screen.
- **Demo traffic is tagged** `switchboard-demo` (LiteLLM `user` and tags, and `decision_json.tag` in `requests`).
  Metrics (M6) leaves it out by default ("6 demo requests are left out"); Pro mode has **Include demo traffic**.
- **The Metrics segment uses fixture data** (`PORTAL_DATA=fixture`, dated 21 Nov 2026): the Demo stack has no history
  worth charting.
- The demo router sets `ROUTER_SYNC_ENABLED=false`, so it never writes to LiteLLM or refreshes the catalog; your main
  router stays the only writer.
- GitHub does not play a repo-relative `<video>` in a README, so the README shows the GIF and links to the MP4 (which
  GitHub plays in its file viewer). If you attach the MP4 to an issue or PR you get a `user-attachments` URL that can be
  embedded instead.

## Other generated media

| What | Command |
|---|---|
| Hero and routing SVGs (`hero-*.svg`, `routing-*.svg`) | `npm run gen:media` (from the design tokens) |
| Feature-tour screenshots (`shot-*.webp`, fixture data) | `npm run build && PORTAL_DATA=fixture npx next start -H 127.0.0.1 -p 3215 &` then `PORTAL_URL=http://127.0.0.1:3215 npm run screens:readme`, then stop the server |
| Everything checked | `npm run docs:check` |
