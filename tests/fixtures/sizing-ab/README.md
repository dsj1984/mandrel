# Sizing A/B calibration fixture

This fixture captures an **A/B re-plan** of a single delivered Epic body
under the **old** and **new** Story-sizing constant profiles, so the
recalibration shipped by Epic #3865 (Stories #3874 / #3760) is proven
empirically rather than asserted.

The delivered Epic modeled here is the model-evolution recalibration Epic
itself (#3865): a coherent body of tooling work whose natural capability
slices are wider than the *old* `hardFiles = 15` ceiling allowed. Under the
old profile the planner was forced to shard each wide capability into
multiple narrow Stories to stay under the hard file ceiling; under the new
profile (`hardFiles = 30`) the same capabilities fold into fewer, wider
Stories that each still sit comfortably under the relaxed ceilings.

## What the two plans represent

- `plan.old.json` — the decomposition the **old** sizing profile would
  accept. Each Story's `changes[]` footprint is bounded by the old
  `hardFiles = 15` ceiling, so wide capabilities are split.
- `plan.new.json` — the decomposition the **new** sizing profile accepts.
  The same total delivered work (identical union of file paths) folds into
  strictly fewer Stories, each still within the new ceilings.

Both plans deliver the **same union of files** (`profiles.totalFiles`); only
the *slicing* differs. The A/B test asserts:

1. The new plan emits **strictly fewer** Stories than the old plan.
2. The new plan's **mean files/Story is strictly higher**.
3. Every Story in the new plan is **within the new ceilings**
   (`computeSizingFindings` returns no `oversized-task` hard finding).
4. At least one Story in the **new** plan exceeds the **old** `hardFiles`
   ceiling — i.e. the old profile could not have accepted the wider new
   slicing and was forced to shard the work apart. The fragmentation is
   genuine, not a relabeling.

## Recorded sizing constants

`profiles.json` records the exact constant values each plan was scored
against. The `new` block MUST match `DEFAULT_TASK_SIZING` in
`.agents/scripts/lib/orchestration/ticket-validator-sizing.js` — the A/B
test imports the live constant and asserts the fixture stays in lockstep, so
any future calibration tuning updates both the constant and this fixture in
the same change.
