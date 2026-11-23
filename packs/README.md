# Workflow packs

One folder per pack (SPEC §8a, ADR 0018): `pack.yaml` is the human-edited manifest, `pack.lock.json` is generated
from it and committed. hostprobe only ever reads the lock; the router reads both and refuses a lock that doesn't
match its manifest.

Add or update a pack (maintainers; needs the network):

```bash
python3 scripts/pack-lock.py <id>      # resolves every dependency and records each file's URL and hash
```

Review the lock diff like code: it is exactly what Switchboard will download.

Rules every manifest must follow (checked by the router, `app/packs/registry.py`):

- `source` is an exact package name and version (`npm:<name>@<x.y.z>` or `pypi:<name>==<x.y.z>`); names that look
  alike but are someone else's go in `lookalikes`.
- `scope: [project]`: Switchboard installs pack files only into a job's worktree. A pack that can only install into
  your home folder (`~/.claude/skills` and the like) is listed with `scope: [global]` and is refused, with the reason.
- `project.setup` / `project.prepare` are argv lists. The only placeholders are `{tool_id}` and `{tool_ids}` (the
  pack's own names for the job's agent, from `hosts`).
- `owned` globs: files the setup writes that are never committed (an upper bound: only files the setup actually
  wrote count). `artifacts` globs: the pack's work product, committed with the code. Anything else a setup changes
  is shown to you as an unticked item in the diff review.
- `trust: community` packs are labelled "Unverified" and need an extra confirm.
