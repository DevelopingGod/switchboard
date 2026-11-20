# 0010. Autonomy level 3 runs in a locked-down container per job (M7); off until then

Status: accepted (2026-11-20). Implementation carried over to M7.

## Context
Level 3 ("Full auto", SPEC §7.3) lets an agent run end to end and only shows you the result. SPEC §7.3 and §13 say it
must run in a sandbox, with a budget, in a worktree, and never near real accounts or secrets. In M4a, Paperclip's
bwrap sandbox (`filesystemScope: workspace`) failed to start on Ubuntu 24.04 (`Can't bind mount /oldroot/usr/bin on
/newroot/bin`): `/bin` is a symlink to `/usr/bin` on merged-`/usr` systems (docs/m4a.md, job 9). So level 3 is off for
every agent, with that reason shown wherever the level can be picked. M4b had to choose the way forward, and build it
only if the work was small and safe.

The threat that matters here is a **prompt-injected agent** (for example, a hostile README in the repo it works on).
With level 3 it runs any command without asking. A sandbox has to limit three things:
- what the agent can read and write: only the worktree;
- where it can connect: only its model API;
- which credentials it can reach.

The last one is the hard part. The CLI's own login has to be usable inside the sandbox, or the agent can't work at all.

## Options
1. **A Switchboard bwrap wrapper** around the process runner (and Claude's command). Use `--ro-bind / /` instead of
   Paperclip's per-directory binds, which avoids the merged-`/usr` bug. Add a tmpfs over `$HOME`, the worktree mounted
   read-write, and `--unshare-all --share-net`.
   - *For:* small (a script plus flags), no new images, starts in milliseconds.
   - *Against:* bwrap can only share the network or remove it. An allowlist needs a network namespace plus pasta or
     slirp4netns plus a filtering proxy, which is not small. The CLI's login folder has to be mounted in, so an
     injected agent could read its own token and send it anywhere. Codex and OpenCode need the network for their
     model APIs, so "no network" isn't an option.
2. **A locked-down Docker container per job** (recommended). Use a pinned image per CLI, with only the worktree
   mounted. The container sits on an `internal` Docker network whose only way out is an egress-allowlist proxy
   container (the model API hosts only). It runs as a non-root user with a read-only root filesystem, no capabilities,
   and CPU, memory and pids limits. The CLI is logged in once, inside a named volume, by the vendor CLI itself: your
   host login files are never copied, read or mounted (the rule from M4a).
   - *For:* the network allowlist is actually enforced (no other route out). A token in the volume can only reach the
     allowlisted hosts. Docker is already required. It works the same way on macOS and Linux, which M7 needs.
   - *Against:* images to build, pin and update per CLI version, one extra login per CLI, a slower start (about a
     second), and Paperclip's `process` runner has to start `docker run …` instead of the CLI.
3. **Wait for a Paperclip fix** to its bwrap profile.
   - *For:* no work for Switchboard.
   - *Against:* not in our control, and it still has no network allowlist.

## Decision
Option 2 (your choice, 2026-11-20). It is not small and safe enough to build at the end of M4b. Done right, it means:
- the images;
- the proxy;
- the login volume flow in Connections;
- a live negative test per CLI: read outside the worktree, reach a non-allowlisted host, read the host's
  `~/.claude`.

So it is **carried over to M7** (packaging, where the per-OS container work lands anyway). Until then:
- `config/agents.yaml` has no `full` profile for any agent, and each says why (`full_unavailable`, pointing here).
- The autonomy dial shows level 3 but can't land on it (Dial `disabledStops`), with the reason next to it. The job
  preview and the router refuse it too.

## Consequences
- Jobs run at levels 0–2. Level 2 already confines edits to the worktree and limits commands to an allowlist through
  each CLI's own permission layer (docs/m4a.md).
- M7 work:
  - a `sandbox: container` runner in agents.yaml, with images under `deploy/agents/`;
  - an egress proxy with a per-agent allowlist;
  - a "Log in for sandboxed jobs" flow on each CLI card;
  - doctor checks;
  - the negative tests above, run live before level 3 is switched back on per agent.
