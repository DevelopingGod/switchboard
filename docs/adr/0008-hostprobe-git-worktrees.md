# 0008. Job worktrees are created by hostprobe

Status: accepted (2026-11-20)

## Context
Agents that edit files must work in a git worktree on a new branch, never in your checkout or on your branch, and
nothing may ever be pushed (SPEC §7.3, §13.4). The router runs in Docker and can't see host folders. Paperclip's own
worktree support is an experimental, default-off flag that silently falls back to the project's checkout, defaults to
worktrees inside the repo, and only works for issue-scoped runs, which jobs don't use (ADR 0007). hostprobe already
runs on the host as a loopback service with a token, fixed argv and no shell (M1a).

## Options
1. **hostprobe** gains a few narrow git endpoints. Keeps every host action in one audited place.
2. Turn on Paperclip's experimental flag. Only works with issue-scoped runs (rejected with option 1 of ADR 0007).
3. A Paperclip `process` agent that runs git for Switchboard. Indirect, and the git arguments would travel through
   agent config.

## Decision
Option 1 (your choice). hostprobe gains:
- `POST /git/inspect {path}`: is it a directory, the top of a git work tree, its current branch and HEAD, is it the
  Switchboard repo itself. Read-only. Used when you add a project to the allowlist.
- `POST /git/worktrees {project, slug, job_id}`: `git worktree add -b switchboard/job-<id>
  <root>/<project-slug>/job-<id> HEAD`.
- `POST /git/worktrees/diff {project, slug, job_id, base}`: the job's changes against its base commit (tracked changes
  plus new files), capped at 1 MB.
- `POST /git/worktrees/commit {project, slug, job_id, message}`: commits the job's changes on its own branch (after
  you approve the diff), so the work survives the worktree's removal.
- `POST /git/worktrees/remove {project, slug, job_id}`: `git worktree remove --force`; the branch is kept; already
  gone = success.
- `GET /git/worktrees?project=&slug=`: the job worktrees, whether each branch is merged into your current branch, and
  disk used.
- `GET /net/listen?port=`: which addresses a local port listens on (from `/proc/net/tcp*`), for the Paperclip loopback
  check.

Rules hostprobe enforces itself, whatever the router sends:
- Paths are resolved (`realpath`), must be absolute directories and the top of a git work tree; never the Switchboard
  repo (the one hostprobe runs from) unless `SWITCHBOARD_ALLOW_SELF=1`.
- Worktrees live only under one root (`SWITCHBOARD_WORKTREE_ROOT`, default `~/.switchboard/worktrees`), branch names
  are exactly `switchboard/job-<number>`, the base is the project's current HEAD, and your checked-out branch is never
  touched.
- git runs with a fixed argv list, no shell, `--` before paths, a timeout, `GIT_TERMINAL_PROMPT=0`, no editor or
  pager, and never `push`, `fetch` with credentials, `reset` or `clean` on your checkout.
- The project allowlist lives in the router's database; the router checks a job's project against it before calling
  hostprobe. hostprobe's rules are the second layer.

This changes hostprobe's M1a stance ("nothing from a request reaches a command"): a project path and a job number do
now reach `git` as arguments. The rules above, argv-only execution and the allowlist bound what they can be.

## Consequences
- Worktrees sit outside your repos (`~/.switchboard/worktrees/<project>/job-<id>`), so `git status` in your checkout
  stays clean; `git worktree list` shows them.
- Retention: a job's worktree is removed when it is rejected, fails or is stopped, or when its branch is merged; at
  most `keep_worktrees` others are kept per project (oldest removed first). Branches are never deleted automatically.
- hostprobe gains tests for each rule (path escapes, the self-repo refusal, branch pattern, idempotent remove).
