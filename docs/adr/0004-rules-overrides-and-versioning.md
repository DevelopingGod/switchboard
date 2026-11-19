# 0004. Rules UI: overrides over rules.yaml, versioned in the database

Status: accepted (2026-11-19)

## Context
SPEC §7.2 / §11 M3b: rules and presets must be editable in the portal with validation, history, diff and
rollback, while `config/rules.yaml` stays the base (it is mounted read-only, lives in git, and is what a new
install starts from). Principle 2: config over code; principle 8: one validation path, no weakened checks.

## Options
1. **Per-rule rows** with per-row history. Fine-grained, but ordering, presets, slash commands, classifier
   routes and weights are not rows; a consistent snapshot needs joins and a second code path for validation.
2. **Whole override documents**, append-only (`rules_versions`), newest row = current. One JSON document shaped
   like rules.yaml (partial), merged onto the raw base dict and parsed by the same `rules.parse()` that loads the
   file. Diff and rollback are trivial; consistency is by construction.
3. **Write back to rules.yaml.** Loses the read-only base and git as the source for defaults; two writers.

## Decision
Option 2. Details:
- Merge by id: edit fields, `disabled: true` removes, a new id adds (before `default`, or `before: <id>`);
  slash, presets (paid + per-rule overlay), classifier route descriptions and scalars, recommender weights,
  quota, summary and defaults merge key by key. Lists (a fallback chain) are replaced whole.
- Validation = field names and ranges, target syntax checked against the registry (aliases, providers,
  capabilities), sizes (64 KB, 100 rules, 10 fallbacks), then the existing `parse()`. Every problem is returned
  with a path and a plain sentence. Targets that rules.yaml itself already uses stay valid (it references
  `model:grok` before that alias exists).
- **Privacy invariant:** the `private` rule can't be removed, re-aimed at a non-local target, given
  fallbacks, or changed by a preset. The engine enforces local-only in code as well; this keeps the UI honest.
- Versioning: saving the same document is a no-op; a stale editor (`base_version` mismatch) gets 409 and
  nothing is overwritten; rollback appends a copy of an old version (`source: rollback`), so history is never
  rewritten. History is keyset-paginated; diff is computed on read (leaf paths; a chain is one change).
- Self-healing: `effective_rules()` is cached by (rules.yaml mtime, version id), at most 4 entries. If the
  base changes so that saved overrides no longer validate, routing uses the plain file and `GET /rules`
  reports the problem until the owner fixes or resets it; requests never fail.
- Dry-run accepts an unsaved `draft` of the same document, so a change can be tested before saving.
- Editable in the UI: everything above except classifier route `facts` of built-in routes (edit the
  description instead, so a sensitive route can't be re-labelled into a non-sensitive one).

## Consequences
- One validation path; a new rules.yaml field needs a line in `overrides.py` to become editable.
- Settings (caps, private default) still sit above this, in `system_meta`: the stricter cap wins as before.
- Rows are small and rarely written; no pruning yet. If history ever matters for size, prune by age in a
  later milestone (carry-over).
