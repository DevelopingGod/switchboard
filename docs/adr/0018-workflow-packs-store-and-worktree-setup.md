# 0018. Workflow packs: a hash-locked pack store, set up per job inside the worktree, never committed silently

Status: accepted (2026-11-23, M4.5a)

## Context
SPEC §8a: workflow packs (OpenSpec, graphify, Spec Kit, …) are installed on demand from `packs/<id>/pack.yaml`
manifests. A pack has two parts: a **program** (an npm or PyPI package with a CLI) and **per-project files** (skills,
hooks, config) that the agent CLI reads. The owner's rule for M4.5a: packs never touch `~/.claude`, `~/.codex`,
global hooks or settings, and nothing a pack writes is committed without the owner seeing it.

Verified before building (2026-11-23, this machine):
- **OpenSpec 2.1.1** (npm `@fission-ai/openspec`, Node ≥ 22.20, 66 locked packages, no install scripts).
  `openspec init --tools claude,codex,opencode --scope project` writes `.agents/skills/openspec-*/SKILL.md`,
  `.agents/skills/.openspec-target`, relative links `.claude/skills/openspec-* → ../../.agents/skills/…`, and
  `openspec/` (`config.yaml`, `specs/`, `changes/archive/`). It edits no tracked file. It writes
  `~/.local/share/openspec/projects.json` and, unless disabled, a telemetry id under `~/.config/openspec`.
  The `/opsx:*` commands of 1.x are now skills: `openspec-propose`, `openspec-apply-change`,
  `openspec-archive-change` (Codex invokes them as `$openspec-…`).
- **graphify 0.9.115** (PyPI `graphifyy`, double y; `graphify` does not exist on PyPI; Python 3.11.5–3.14;
  31 wheels, ~30 MB, 190 MB installed). `graphify extract . --code-only` with `GRAPHIFY_BACKEND=none` is a local
  tree-sitter pass that writes `graphify-out/`. `graphify install --project --platform claude` writes
  `.claude/skills/graphify/**`, creates `.claude/settings.json` (PreToolUse hooks that call `graphify hook-guard` by
  name) **and appends a "## graphify" section to the tracked `AGENTS.md`**, which its docs don't say. It writes
  `~/.cache/graphify/skill-locks/`.
- The host has no `uv`, `pipx` or `ensurepip` (installing `python3-venv` needs sudo). `python3 -m venv
  --without-pip` plus a pinned pip wheel (`python pip.whl/pip install …`) works without sudo.
- `unshare --map-current-user --net` works without root here: same uid, no network.
- `npm ci --offline --ignore-scripts` installs from local tarballs when the lockfile's `resolved` points at them
  (npm still checks each `integrity`). Filling npm's cache with `npm cache add` does **not** work offline (the
  cache is keyed by URL).

## Options
**Where the program lives**
1. **Switchboard's own pack store** `~/.switchboard/packs/<id>/<version>/`, shared by jobs (your choice).
2. Inside every job's worktree, every job: strictest, but a download and 1–2 minutes per job (graphify ~190 MB).
3. The user's global npm/pip prefix: rejected (touches global state, not versioned per pack).

**How it is pinned**
1. Top-level version only: transitive dependencies float.
2. **A committed lock per pack** with every artifact's URL and hash; hostprobe reads only the lock.

**What happens to files a pack writes into the worktree**
1. Refuse any pack that edits a tracked file: graphify could not be used at all.
2. **Sort every write, and show the unexpected ones to the owner** (your choice, below).

## Decision
- **Registry:** `packs/<id>/pack.yaml` (human source, validated by the router like rules/agents) and a committed
  `packs/<id>/pack.lock.json` generated from it by `scripts/pack-lock.py <id>` (maintainer only; needs the network).
  The lock holds the normalized argv, the manifest fields hostprobe needs, and every artifact:
  - npm: the full `package-lock.json` (URL + sha512 integrity of all transitive packages).
  - PyPI: per target (`cp311`–`cp314` × manylinux x86_64/aarch64 × macOS arm64/x86_64), the exact wheels with
    sha256, plus a pinned pip wheel. A target that can't be satisfied is listed with its reason.
  hostprobe is stdlib-only (no YAML) and never takes argv from a request, so it reads only the lock; a router test
  fails when the lock and the YAML disagree.
- **Install** (hostprobe, plan → confirm → streamed log, one at a time, never root, a `sudo` shim):
  1. Download only the lock's URLs (https; hosts `registry.npmjs.org`, `files.pythonhosted.org`), check each hash,
     and check the **name and version inside** each artifact (`package.json`, wheel `METADATA`) against the lock:
     a typosquat or swapped file fails here.
  2. Install offline under `unshare --map-current-user --net`: npm `ci --offline --ignore-scripts` from the
     downloaded tarballs; PyPI into `venv --without-pip` with the pinned pip, `--no-index --require-hashes
     --only-binary :all:`. Python packs are byte-compiled **before** the manifest is written. Where user
     namespaces aren't available, the plan says so and the install still uses only the verified files.
  3. Write **wrappers** (`<version>/sbbin/<cli>`), a `store.manifest.json` (every file's sha256 and a tree hash),
     then make the version folder read-only. Run `detect`.
  - Two versions are kept (current + previous); **rollback** re-verifies and switches the `current` pointer;
    anything older is pruned on install; **uninstall** removes the folders (already gone = success).
- **Wrappers** are the only pack entries on a job's `PATH` (the router prepends `<version>/sbbin` to the Paperclip
  service's PATH for that run). Each finds the worktree by walking up to `.switchboard/packs.json` (and must be under
  the worktree root, else it refuses), sets `HOME` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` to
  `<worktree>/.switchboard/home`, the manifest's `env` (telemetry off, no update check, `GRAPHIFY_BACKEND=none`)
  and `PYTHONDONTWRITEBYTECODE=1`, then `exec`s the real CLI. So the tools' own state lands in the git-ignored
  `.switchboard/` whether hostprobe runs them (setup) or the agent does (during the job).
- **Before every use** hostprobe re-hashes the version folder against its manifest (the time is measured and
  reported). A changed, missing or extra file refuses that pack for the job with one plain sentence and one action
  ("… changed on disk since it was installed — reinstall it in Connections → Packs"); the job continues without it.
- **Per-job setup** (hostprobe, a background task the job loop polls): the manifest's setup argv runs in the
  worktree through the wrappers, with a minimal environment, no network, a timeout. A `git status` snapshot (with
  hashes) before and after sorts every write:
  - **owned**: the exact files the setup wrote that fall inside the manifest's `owned` globs (the globs are only an
    upper bound), plus new top-level folders that match them (`graphify-out/`). Never committed: diff and commit
    exclude them by literal pathspec, like `.switchboard/`. A project's own tracked `.claude/skills/*` stay
    committable.
  - **artifacts** (`openspec/**`): the pack's work product, reviewed in the diff and committed with the code.
  - **setup edits**: anything else (graphify's `AGENTS.md` section, a file outside the declared paths). Their exact
    patch is kept in `.switchboard/packs/`; the diff review lists them as a separate group, **unticked by default**.
    An unticked edit is reverse-applied to the **index only** at commit, so the agent's own changes to the same file
    are still committed. If the agent changed the same lines, the file is flagged "edited by both" and is decided
    as a whole.
  - A link that resolves outside the worktree rolls the setup back and refuses the pack.
- Everything is recorded: `pack_installs` rows for install/update/rollback/uninstall, `job_events` for each job's
  setup (files written, setup edits, timings, refusals).

## Consequences
- Jobs reuse one verified install; a pack update is one download, and rollback needs no network.
- A pack's per-project files never leave the worktree and never reach a commit unless the owner ticks them.
- The store is outside the worktree (`~/.switchboard/packs`), like worktrees and attachments; the owner's own
  agent folders (`~/.claude`, `~/.codex`, `~/.agents`) and global npm/pip are never written.
- Re-hashing the store costs time on every job (graphify: ~3,400 files). Measured and reported in the M4.5a
  outcome; changing it needs the owner's decision.
- A pack whose only install mode is global (into `~/.claude/skills` and the like) is refused with that reason.
- Maintainers regenerate a lock to update a pack; the lock diff is the review.
