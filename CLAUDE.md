Read SPEC.md and docs/PROGRESS.md before any work. Build one milestone at a time and stop for review after each.

At the end of every milestone, update docs/PROGRESS.md (status table, outcomes, carry-overs) in the same PR.

## Engineering principles (apply to every decision)
1. Open source first: never hard-code the owner's hardware, providers, keys, paths or preferences. Detect, configure, default.
2. Config over code: providers, models, limits, rules, profiles, packs live in YAML with validation. New provider/model/
   profile = config change, not code change, wherever possible.
3. Thin adapters around every external dependency (LiteLLM, Paperclip, Ollama, hostprobe, provider APIs). Pin versions.
   Contract tests catch upstream changes.
4. Scale and longevity: no O(n²) over threads/messages, paginate lists, index queries, no unbounded in-memory state,
   persist anything that must survive restarts.
5. Self-healing and idempotent: retries with backoff, "not found on delete" = success, plain-language errors with one action.
6. Security and privacy are non-negotiable: secrets server-side only, private stays local, loopback by default, never sudo.
7. Performance budgets are hard limits: ≤ 200 KB JS per route, Lighthouse ≥ 90, axe clean, CLS < 0.05.
8. No shortcuts that create debt: no "temporary" hacks without a TODO linked to a PROGRESS carry-over item; no
   skipped or weakened tests to make a check pass; no silent scope cuts.

## Decision protocol
- For any non-trivial choice (architecture, data model, dependency, security, UX pattern): list 2–3 options with
  trade-offs, recommend one, and ask before building if it is hard to reverse.
- Record each significant decision as a short ADR in docs/adr/NNNN-title.md (context, options, decision, consequences).
- Prefer the boring, proven option unless there is a measured reason not to.
- If something in the spec looks wrong or sub-optimal, say so and propose a better path — don't silently follow or
  silently deviate.

## Definition of done for every milestone
- All of the milestone's own "done when" checks pass, and docs/PROGRESS.md is updated (see the top of this file).
- **README.md is updated for every user-visible change:** features, screenshots (docs/media, compressed, with alt
  text), roadmap (✅/🔜/💡 must match the PROGRESS.md status table), quickstart, and the demo recording if the UI
  changed (docs/recording-the-demo.md). Keep every claim true today: if it is not shipped, it is marked "coming in Mx".
- `npm run docs:check` (from `apps/portal`) passes: links and images resolve, every image has alt text, media size
  limits hold, the version in VERSION matches everywhere, and the README roadmap matches PROGRESS.md.
- The one project version lives in the root `VERSION` file. Bump it there; never edit the copies by hand.

### Efficiency rules (part of the definition of done)
- **Demo video:** re-record only at M7, or when the owner asks. **README screenshots:** regenerate only for pages that
  changed.
- **Tests:** while working, run only the affected tests; run the full suite **once** before the PR (in the
  background, with a generous timeout).
- **Lighthouse:** 3 runs per changed route (10+ only when a change targets performance). **Visual repeat-each:** only
  for new or changed baselines.
- **Live checks:** only what the milestone changes; reuse existing fixtures and the playground.
- **Time box:** if any single step runs > 20 minutes, stop, commit WIP, and report what is slow.
- **Small milestones:** split anything with more than ~8 scope items.
