/**
 * Story authoring guidance the story-author prompt cites — prose on how to
 * think about a slice, deliberately not a number that scores it. Stated once
 * so no second copy drifts.
 */

/** Cohesion, not size, is the only sizing test. */
export const DELIVERABLE_GRANULARITY_GUIDANCE = Object.freeze({
  definition:
    'A Story is a **capability slice a frontier model delivers and self-verifies in one pass** — one coherent change with one reason to exist, a capability or user-visible surface, **not a single module or file**. Fold module-level slices into the capability they belong to rather than emitting one Story per module. A remediation sweep over one subsystem is one Story; its stages belong in `## Slicing`, not in sibling tickets.',
  singleConsumerRule:
    '**Single-consumer merge rule.** A Story whose only consumer is one sibling Story should be **merged into that sibling** rather than emitted separately — a single-consumer downstream slice is not its own unit of work.',
  envelopeFloor:
    '**Thin dependent slices are a merge signal.** A Story that is neither parallel-deliverable nor orthogonal to its siblings — especially a short `depends_on` fragment whose only job is to feed one consumer — should be **merged into its consumer**. Modern frontier models one-shot capability-sized changes, so a chain of small dependent Stories needlessly pays a full delivery session (branch, PR, review, CI) per link. Merge such links up unless a parallelism or orthogonality reason justifies the separate slice.',
});

/** Binding-vs-advisory authoring altitude and the New-File Contract. */
export const AUTHORING_ALTITUDE_GUIDANCE = Object.freeze({
  altitude:
    '**Binding contract vs advisory sketch.** `acceptance[]` and `verify[]` are the Story\'s **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: your best prediction of the file footprint, which the executor MAY revise when the real codebase diverges from the sketch. Author `acceptance[]` / `verify[]` to assert the **outcome** independent of any one file layout — never pin an incidental implementation detail (an internal helper name, a private file path) into an acceptance item that the advisory `changes[]` is free to reshape; assert the observable behaviour instead.',
  advisoryCaveat:
    "**Advisory does not mean unchecked.** `changes[]` paths are still probed against the base branch: a `creates` on an existing path or a `refactors-existing` on an absent one is reported as a dry-run warning, and a `deletes` naming a path absent at base is refused. The executor's latitude to revise the approach never licenses skipping `acceptance[]` / `verify[]` or relaxing any `rules/security-baseline.md` MUST.",
  newFileContract:
    '**New-File Contract.** Any path named in a Story\'s `goal`, `acceptance`, or `verify` that does NOT already exist on `main` should also appear in that Story\'s `changes[]` with `assumption: "creates"`; the dry-run warns on any such path it cannot find at base — even when the Story is the one authoring the file.',
});
