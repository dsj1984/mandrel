/**
 * deliver-phases.js — phase enum and ordering utility for `/epic-deliver`.
 *
 * Story #1155 (Epic #1142, 5.40.0). Extracted from `checkpointer.js` so
 * the Checkpointer class stays focused on the structured-comment
 * read/write surface and the close-tail phase semantics live in a
 * dedicated module that downstream tooling (the contract test) can import
 * without dragging the provider-coupled Checkpointer along.
 */

/**
 * Ordered list of `/epic-deliver` phases. The checkpoint's `phase` field
 * stores the **next phase to run**, so a mid-flight crash during
 * `code-review` resumes by reading `phase === 'code-review'` and re-
 * entering Phase D from the start.
 */
export const DELIVER_PHASES = Object.freeze([
  'prepare',
  'wave-loop',
  'close-validation',
  'code-review',
  'retro',
  'finalize',
]);

/**
 * Pure: index of `phase` in `DELIVER_PHASES`. Returns `-1` for unknown
 * values (callers treat that as "start fresh"); `+Infinity` for the
 * terminal `'done'` sentinel.
 */
export function phaseIndex(phase) {
  if (phase === 'done') return Number.POSITIVE_INFINITY;
  return DELIVER_PHASES.indexOf(phase);
}

/**
 * Pure: validate that `nextPhase` is a known phase tag (or the terminal
 * `'done'` sentinel). Throws on invalid input — exported so the
 * Checkpointer's `setPhase` and downstream callers share one failure mode.
 */
export function assertValidDeliverPhase(nextPhase) {
  if (nextPhase === 'done') return;
  if (phaseIndex(nextPhase) >= 0) return;
  throw new Error(
    `Invalid /epic-deliver phase ${JSON.stringify(nextPhase)}. ` +
      `Expected one of ${DELIVER_PHASES.join(', ')} or 'done'.`,
  );
}
