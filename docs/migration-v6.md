# v6 migration notes

This file collects the operator-facing migration notes for the v6 line of
`agent-protocols`. v6 is a **major-boundary** release: the quality-gate
contract changed shape in ways that are visible to any consumer who
re-runs `npm run lint`, `coverage:check`, `maintainability:check`, or
`crap:check` against a previously-passing tree.

If you are upgrading a consuming repository from v5.x → v6.x, read this
file once before bumping the `.agents/` submodule pin or the npm
dependency.

---

## Quality-gate contract (Epic #1184)

v5 enforced **per-file ratchet** only: the gate failed when a metric
dropped below the recorded baseline for that file. It said nothing about
the absolute level — a file pinned at 60 % coverage or MI = 58 for years
sailed through every push.

v6 layers an **absolute floor** on top of the ratchet. The three
checkers (`check-coverage-baseline.js`, `check-maintainability.js`,
`check-crap.js`) all delegate to the shared
`lib/quality-floors.js#applyFloorPolicy` helper after their ratchet
decision, with the contract:

| Metric                  | v5      | v6 floor   |
| ----------------------- | ------- | ---------- |
| Coverage — lines        | ratchet | ≥ 90 %     |
| Coverage — branches     | ratchet | ≥ 85 %     |
| Coverage — functions    | ratchet | ≥ 90 %     |
| Maintainability Index   | ratchet | ≥ 70       |
| CRAP                    | ratchet | ≤ 20       |

The floor block is enabled **by default**. The only opt-out is the
`--floor=off` flag, used exclusively by the `*:update` baseline-snap
scripts (which need to record whatever the current numbers are without
regard to the floor).

See [`docs/quality-gates.md#absolute-quality-floors-v6--epic-1184`](quality-gates.md)
for the runtime details.

### Why this is a major-version bump

Two reasons make the v5 → v6 contract incompatible:

1. **Behaviour change for consumers.** A consuming repo whose tree was
   green on v5 can fail v6's gate on its very first post-upgrade
   `pre-push` even with no source changes, because in-scope files that
   were sitting below the new floors will now trip the gate.
2. **`.agentrc.json` schema growth.** v6 reads
   `agentSettings.quality.qualityFloors.*` (validated by
   `loadFloorConfig`) — an unknown axis throws. Consumers that author
   their own `.agentrc.json` may need to add an empty `qualityFloors:
   {}` block to inherit defaults or override specific axes.

---

## Baseline reset (Story #1602)

Story #1602 of Epic #1184 ships the floor gate and **re-snaps all three
baselines** to the post-remediation state of `main`. After the reset:

- `baselines/coverage.json` — 274 in-scope files, captured from
  `coverage/coverage-final.json` after the v6 `.c8rc.cjs` exclude prune
  (Task #1627 removed two stale entries whose source files had already
  been deleted).
- `baselines/maintainability.json` — 650 files scored by `escomplex`.
- `baselines/crap.json` — 1383 method-level rows, scored against the
  fresh coverage capture.

### The v5 → v6 discontinuity

The post-snap baselines are intentionally **the current state**, not
the v6-floor state. Numeric diffs against pre-v6 snapshots are
meaningless because:

- The `.c8rc.cjs` exclude list changed (smaller, two stale entries
  removed). Per-file numbers for the removed files are now real,
  whereas they used to be zeros.
- `lib/quality-floors.js` is new and shows up as a new baseline row.
- The MI calculator pinned its kernel version; pre-pin scores may
  drift by sub-1 MI on noisy files.

A direct comparison reports "everything changed." That is expected.
Diff-shaped triage (per-file regressions on `check-coverage-baseline`'s
`---changed-since origin/main` path) keeps working — the ratchet
half of the gate is unaffected by the reset.

### Files known to be below floor on first v6 push

The fresh snap also surfaced the v5 → v6 discontinuity in the other
direction: a number of pre-existing files in the agent-protocols
repository itself are **below the v6 absolute floor**. The floor gate
will fail on these the first time it runs full-scope (the `pre-push`
hook, the post-merge CI step, or `npm run *:check -- --full-scope`).

This is intentional. The Story #1602 charter is "wire the gate +
re-snap baselines"; clearing the in-tree below-floor files is sized as
follow-up Stories under Epic #1184 (one per cluster of related files).
Until those land, operators have two options for the agent-protocols
repo itself:

- **Recommended:** treat each below-floor file as a Sev-3 issue and
  refactor / add tests against the floor in a follow-up Story. The
  floor gate stays enforcing; below-floor files block their own
  pushes until they pass.
- **Escape hatch (use sparingly):** pass `--floor=off` on the offending
  checker invocation. The audit suite spot-checks for accidental
  long-lived `--floor=off` uses in `.husky/pre-push` and
  `.github/workflows/`. Never wire `--floor=off` into a default
  workflow — it defeats the entire gate.

The current below-floor inventory (as of 2026-05-13 snap) is:

**Coverage (lines/branches/functions vs 90/85/90):**

- `.agents/scripts/lib/worktree/lifecycle/creation.js` — lines 84.87, branches 83.33
- `.agents/scripts/lib/worktree/lifecycle/force-drain.js` — lines 87.68, functions 60.00
- `.agents/scripts/lib/worktree/lifecycle/gc.js` — branches 81.25
- `.agents/scripts/lib/worktree/lifecycle/pending-cleanup.js` — lines 88.26, branches 78.57
- `.agents/scripts/lib/worktree/lifecycle/reap.js` — lines 85.46, branches 74.44
- `.agents/scripts/providers/github.js` — lines 83.78, branches 67.86, functions 82.35
- `.agents/scripts/providers/github/projects-v2-graphql.js` — lines 85.13, branches 82.18

**Maintainability Index (vs 70):**

- `.agents/scripts/lib/config-schema.js` — MI 59.46
- `.agents/scripts/lib/config-settings-schema.js` — MI 46.09
- `.agents/scripts/lib/orchestration/epic-cleanup.js` — MI 0.00
- `.agents/scripts/lib/orchestration/epic-deliver-close-tail.js` — MI 67.92
- `.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js` — MI 0.00
- `.agents/scripts/quality-watch.js` — MI 0.00

**CRAP (per method, vs 20):**

- `.agents/scripts/lib/worktree/lifecycle/reap.js#reap` — 27.69
- `.agents/scripts/lib/worktree/node-modules-strategy.js#installDependencies` — 22.30
- `.agents/scripts/lint-baseline.js#diffBaseline` — 28.37
- `.agents/scripts/lint-baseline.js#checkBaseline` — 53.47
- `.agents/scripts/providers/github.js#resolveToken` — 27.73
- `.agents/scripts/providers/github.js#classifyGithubError` — 210.00
- `.agents/scripts/providers/github/projects-v2-graphql.js#resolveToken` — 30.00
- `.agents/scripts/signals-view.js#parseArgs` — 20.21
- `.agents/scripts/story-close.js#runStoryCloseLocked` — 45.57

Each cluster will be addressed by a follow-up Story under Epic #1184.
The list above is the cross-check evidence for the close-out audit
trail; once a follow-up Story lands a fix, the line above moves to the
"Resolved" section of the relevant Epic retrospective.

---

## Upgrade checklist (consumer repos)

1. Bump the `.agents/` submodule pin (or the npm dependency) to the
   first v6 tag.
2. Run `npm run coverage:check -- --full-scope`,
   `maintainability:check -- --full-scope`, `crap:check --full-scope`
   from your repo root. Each failure names the specific file and
   metric. Decide for each: add tests, refactor, or — if the file is a
   legitimate thin CLI shell whose logic lives in tested `lib/` — add
   an entry to your repo's `.c8rc.cjs` exclude list (with rationale +
   pragma, per [`docs/quality-gates.md`](quality-gates.md#no-silent-excludes-c8rccjs-policy)).
3. Re-snap your own baselines via the `*:update` scripts once the tree
   is clean.
4. Confirm `.husky/pre-push` reflects the v6 hook layout (ratchet calls
   first, then the three `--full-scope` floor calls).
