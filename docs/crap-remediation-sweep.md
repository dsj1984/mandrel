# CRAP Remediation Sweep — Epic #1653, Story #1703

This document records the per-cluster verification that every in-scope
method under `.agents/scripts/` has CRAP ≤ 20, satisfying the Story #1703
acceptance criteria. It is the durable artefact tying Tasks #1704, #1706,
and #1708 to the live baseline state.

Source baseline: `baselines/crap.json` on `story-1703` (forked from
`epic/1653` after the per-epic baseline snapshot at commit `237670a`).

## Method

For each cluster the verification is:

1. Filter `baselines/crap.json#rows` by the cluster's path prefix.
2. Assert no row has `crap > 20`.
3. Record the count of rows at exactly `crap === 20`. These sit at the
   floor and are AC-compliant; they are listed here so future drift is
   detectable.

The exact-20 rows are not over-floor and require no further extraction.
The CRAP gate (`npm run crap:check`) treats `> 20` as a hard ceiling for
new methods (see `.agentrc.json#qualityFloors.crap` = 30 for the
regression gate and `newMethodCeiling` = 30 for new methods); the
aspirational `≤ 20` floor used by this Epic is enforced by review, not
by the gate.

## Cluster: `.agents/scripts/lib/orchestration/` (Task #1704)

- Methods scanned: 383
- Methods with CRAP > 20: **0**
- Methods at CRAP = 20 (at the floor): 3
  - `lib/orchestration/story-close-recovery.js::dropWorktreeIfPresent` (line 265)
  - `lib/orchestration/story-close-recovery.js::reseedWorktreeIfNeeded` (line 288)
  - `lib/orchestration/story-close/baseline-attribution-wiring.js::projectCrapForGate` (line 501)

The orchestration cluster, including the `epic-runner/` and `ticketing.js`
hot paths called out in Epic #1653 Items 3, 4, 7, and 10, sits at or
below the floor. The cascade-grouping extraction landed in
`feat: parallelize cascadeCompletion parents in disjoint ancestor groups`
(commit `aae6f859`, resolves #1665) reduced the `ticketing.js`
CRAP-cluster substantially and is reflected in the current baseline.

## Cluster: `.agents/scripts/providers/` and `epic-execute-record-wave.js` (Task #1706)

- Methods scanned in `providers/`: 38
- Methods scanned in `epic-execute-record-wave.js`: 25
- Methods with CRAP > 20 in either: **0**
- Methods at CRAP = 20 (at the floor) in either: 0

The `providers/github.js` GraphQL-primary path (Epic #1653 Item 3) and
the `epic-execute-record-wave.js` envelope-diet work (Item 2) landed
without raising any method above CRAP 20. The single notable hot
method, `epic-execute-record-wave.js::main` (line 960), sits at CRAP
17.18 and remains under the floor.

## Cluster: remaining (`lib/wave-runner/`, `lib/audit-suite/`, top-level scripts) (Task #1708)

- Methods scanned across `lib/wave-runner/`, `lib/audit-suite/`, and
  `.agents/scripts/*.js` top-level: see baseline
- Methods with CRAP > 20: **0**
- Methods at CRAP = 20 (at the floor) in top-level scripts: 17

The wave-runner cluster (`lib/wave-runner/tick.js` after Item 5) and the
audit-suite cluster (after the substitutions cache, Item 9) sit under
the floor. The 17 top-level-script methods at exactly CRAP 20 are
predominantly `main` entry points whose branch fan-out is a function of
CLI flag parsing; they remain AC-compliant.

## Inventory Cross-Check

The independent `/audit-clean-code` re-run on the post-Epic-#1653 tree
(Story #1700, Task #1712, commit `6a17eb28`) reports the same finding:

> **Methods with CRAP > 20**: **0**

— see `docs/quality-floor-inventory-v6-1-0.md` on `main`.

## Branch Coverage Note

Story #1703 acceptance also calls for branch coverage ≥ 85% on every
changed file post-change. Because no file in this Story is modified to
remediate CRAP (no over-floor method exists), no file is "changed" in
the AC sense — the branch-coverage clause is vacuously satisfied for
the Story's diff. Branch-coverage gaps that remain in the cluster
(documented in `docs/quality-floor-inventory-v6-1-0.md`) are tracked by
the sibling Stories under Feature #1699 (`coverage + MI remediation`),
not by this Story.

## Verification Commands

The acceptance commands declared on each Task:

```bash
npm run crap:check        # Task #1704 + #1706 + #1708 — validate
npm run coverage:check    # Task #1704 + #1706 + #1708 — validate
npm test -- tests/lib/orchestration   # Task #1704 — unit
npm test -- tests/providers           # Task #1706 — unit
npm test                              # Task #1708 — full unit
```

These are re-run by `story-close.js` as part of the close-validation
chain before the Story branch merges into `epic/1653`.
