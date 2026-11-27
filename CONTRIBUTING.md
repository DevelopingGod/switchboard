# Contributing to Switchboard

Thanks for looking. Switchboard is early and moves one milestone at a time, so the most useful contributions
right now are **bug reports, provider/model config fixes, and docs**. For anything bigger, open an issue first
so we can agree on the approach before you build it.

## Ground rules

- Read [SPEC.md](SPEC.md), [docs/PROGRESS.md](docs/PROGRESS.md) and the engineering principles in
  [CLAUDE.md](CLAUDE.md) first. They are short and they are the project's memory.
- **Config over code.** A new provider, model, rule or profile should be a YAML change (`config/`) wherever possible.
- **Private stays local, secrets stay server-side, no `sudo`, loopback only.** Changes that weaken these will not be merged.
- **Honest docs.** If a feature is not shipped, the README says "coming in Mx", not "supports".
- Significant decisions get a short ADR in [docs/adr](docs/adr) (context, options, decision, consequences).

## Setup

Switchboard currently runs on **Windows 11 + WSL2 (Ubuntu) + Docker Desktop**. macOS and Linux are planned (M7).
Follow the Quickstart in the [README](README.md#quickstart) and [docs/m0.md](docs/m0.md), then check your machine:

```bash
scripts/doctor.sh
```

## Tests and checks

Run the ones that cover what you changed. CI is planned for M7, so please run them locally.

| Area | Command |
|---|---|
| Router (Python) | `docker compose --env-file deploy/.env -f deploy/docker-compose.yml run --rm router pytest` (and `ruff check`) |
| hostprobe | `python3 -m unittest discover -s services/hostprobe/tests` |
| Portal | from `apps/portal`: `npm run typecheck && npm run lint && npm test`, then `npm run build`, `npx playwright test` and `npm run test:console` (no console errors, on a `next dev` server) |
| Performance budget | `npm run budget` (every route ≤ 200 KB first-load JS; we keep ≥ 8 KB headroom) |
| README / docs | `npm run docs:check` |

Do not weaken or skip a test to make a check pass. If a visual baseline changes on purpose, regenerate it and say why in the PR.

## Branches and pull requests

- One milestone or one focused change per branch and PR. Never push to `main`.
- Commit messages say what changed and why. Do not commit secrets (`scripts/setup-wsl.sh` enables a gitleaks pre-commit hook).
- Update [docs/PROGRESS.md](docs/PROGRESS.md) and, for user-visible changes, the README, in the same PR.
- Keep PRs reviewable: screenshots for UI changes (both themes), numbers for performance changes.

## Reporting bugs

Open an issue with what you did, what you expected, what happened, and the output of `scripts/doctor.sh`
(it redacts secrets). Never paste an API key.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
