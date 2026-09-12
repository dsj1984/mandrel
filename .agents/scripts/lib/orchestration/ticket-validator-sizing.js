/**
 * Story authoring guidance — the two prose constants the story-author prompt
 * and the `core/scope-triage` skill both cite, stated once so the surfaces
 * cannot drift.
 *
 * Story #5312 deleted the numeric sizing model that used to live beside
 * them: `DEFAULT_MODEL_CAPACITY` with its soft / hard session-mass ceilings,
 * the `wide` declaration that lifted the hard one, the `merge-candidate`,
 * `unanchored-constant` and `missing-reason-to-exist` findings, and the
 * `estimateStorySessionMass` estimator they read. None of those ceilings
 * fired on real work — the hard ceiling never rejected an accepted Story, and
 * the soft ones duplicated a judgment the authoring model already makes — so
 * a Story is now as large and as loosely prescribed as the work needs. What
 * survives here is the prose that says *how* to think about a slice, not a
 * number that scores it.
 */

/**
 * `DELIVERABLE_GRANULARITY_GUIDANCE` is the **single source of truth** for the
 * deliverable-granularity definition of a Story (Story #3777). It is stated
 * ONCE here and consumed by BOTH the story-author prompt template and the
 * authoring SKILL.
 */
export const DELIVERABLE_GRANULARITY_GUIDANCE = Object.freeze({
  definition:
    'A Story is a **capability slice a frontier model delivers and self-verifies in one pass** — a shippable slice a reviewer would accept as a single PR, a capability or user-visible surface, **not a single module or file**. Fold module-level slices into the capability they belong to rather than emitting one Story per module.',
  singleConsumerRule:
    '**Single-consumer merge rule.** A Story whose only consumer is one sibling Story should be **merged into that sibling** rather than emitted separately — a single-consumer downstream slice is not its own unit of work.',
  envelopeFloor:
    '**Thin dependent slices are a merge signal.** A Story that is neither parallel-deliverable nor orthogonal to its siblings — especially a short `depends_on` fragment whose only job is to feed one consumer — should be **merged into its consumer**. Modern frontier models one-shot capability-sized changes, so a chain of small dependent Stories needlessly pays a full delivery session (branch, PR, review, CI) per link. Merge such links up unless a parallelism or orthogonality reason justifies the separate slice.',
});

/**
 * `AUTHORING_ALTITUDE_GUIDANCE` is the **single source of truth** for the
 * binding-vs-advisory authoring altitude (Epic #4131 F8) and the New-File
 * Contract (Story #4272).
 *
 * Story #5312 demoted the footprint probes behind the advisory caveat to
 * dry-run warnings: a `creates` / `refactors-existing` mismatch, or a goal or
 * acceptance path absent at base, is now reported and the persist proceeds.
 * Only a `deletes` naming a path absent at base is still refused.
 */
export const AUTHORING_ALTITUDE_GUIDANCE = Object.freeze({
  altitude:
    '**Binding contract vs advisory sketch.** `acceptance[]` and `verify[]` are the Story\'s **binding contract** — the executor MUST satisfy them exactly, and they are the only definition of "done." `changes[]` and `references[]` are an **advisory implementation sketch**: your best prediction of the file footprint, which the executor MAY revise when the real codebase diverges from the sketch. Author `acceptance[]` / `verify[]` to assert the **outcome** independent of any one file layout — never pin an incidental implementation detail (an internal helper name, a private file path) into an acceptance item that the advisory `changes[]` is free to reshape; assert the observable behaviour instead.',
  advisoryCaveat:
    "**Advisory does not mean unchecked.** `changes[]` paths are still probed against the base branch: a `creates` on an existing path or a `refactors-existing` on an absent one is reported as a dry-run warning, and a `deletes` naming a path absent at base is refused. The executor's latitude to revise the approach never licenses skipping `acceptance[]` / `verify[]` or relaxing any `rules/security-baseline.md` MUST.",
  newFileContract:
    '**New-File Contract.** Any path named in a Story\'s `goal`, `acceptance`, or `verify` that does NOT already exist on `main` should also appear in that Story\'s `changes[]` with `assumption: "creates"`; the dry-run warns on any such path it cannot find at base — even when the Story is the one authoring the file.',
});
