/**
 * v5-to-v6-keymap.js — data-driven rewrite table for `.agentrc.json` keys
 * that consumer projects must migrate when upgrading from any v5.x release
 * to v6.0.0.
 *
 * Each entry describes ONE legacy key (`from`, expressed as a dot path
 * rooted at `.agentrc.json`) and either (a) the new key it should move to
 * (`to`, also a dot path), or (b) an explicit `removedIn` deprecation
 * notice when the key is gone entirely with no replacement.
 *
 * The table is consumed by [`migrate-to-v6.js`](../migrate-to-v6.js) as
 * pure data — the migration CLI does no per-key logic of its own; it
 * walks this list and applies each entry. This makes the migration
 * reviewable as a single flat table rather than scattered through CLI
 * branches.
 *
 * Sources (see `docs/CHANGELOG.md` for full provenance):
 *   - v5.31.0 (Epic #900): `sprintClose` → `epicClose` config rename.
 *   - v5.40.0 (Epic #1142): the bulk of the v5→v6 deltas; `epicClose`
 *     block deleted outright (retro is always-on under `/epic-deliver`),
 *     `riskGates.heuristics` → `planning.riskHeuristics`, the
 *     `orchestration.hitl` empty placeholder removed, `executor` key
 *     removed from the schema, three `epicRunner` sub-keys
 *     (`idleTimeoutSec`, `pollIntervalSec`, `logsDir`) removed,
 *     `runners.epicRunner` → `runners.deliverRunner`,
 *     `runners.closeRetry` → `runners.storyMergeRetry`.
 *   - v6.0.0 (Epic #1184): no further key renames at the data level;
 *     the major-version cut tightens `additionalProperties: false` so
 *     that *any* residue from the above renames fails validation up
 *     front rather than being silently ignored. That is precisely the
 *     contract this table exists to satisfy.
 *
 * Entry shape:
 *   - `from` (string, required) — dot path of the legacy key.
 *     Intermediate path segments may be objects or arrays; the consumer
 *     is responsible for walking and creating missing parents on `to`.
 *   - `to` (string | null) — dot path of the new key, or `null` if the
 *     key is removed with no replacement. Mutually informative with
 *     `removedIn`: when `to === null`, `removedIn` MUST be set.
 *   - `removedIn` (string | undefined) — the version that first refused
 *     the legacy key. Helpful in CLI summary output so a consumer can
 *     see "this was deleted in 5.40.0, not just yesterday."
 *   - `transform` (function | undefined) — optional value-shape rewrite.
 *     Called as `transform(legacyValue, { from, to })` and returns the
 *     value to write at `to`. Defaults to identity when omitted. Used
 *     only by the two entries that pluck a single field out of a parent
 *     block (`riskGates.heuristics` carrying its array verbatim, and
 *     `sprintClose.runRetro` becoming an explicit-removal note rather
 *     than a copy).
 *   - `note` (string, required) — single-sentence rationale, surfaced
 *     by the CLI summary so the consumer understands *why* their key
 *     was rewritten and not just *that* it was.
 *
 * The list is FROZEN at module load so callers cannot accidentally
 * mutate the shared table from across a long-running process (the
 * migration CLI is single-shot, but tests reuse the import).
 *
 * @typedef {object} KeymapEntry
 * @property {string} from
 * @property {string | null} to
 * @property {string} [removedIn]
 * @property {(legacyValue: unknown, ctx: { from: string; to: string | null }) => unknown} [transform]
 * @property {string} note
 */

/** @type {ReadonlyArray<KeymapEntry>} */
export const V5_TO_V6_KEYMAP = Object.freeze([
  // -------------------------------------------------------------------------
  // v5.31.0 (Epic #900) — sprint → epic rename
  // -------------------------------------------------------------------------
  Object.freeze({
    from: 'agentSettings.sprintClose.runRetro',
    to: 'agentSettings.epicClose.runRetro',
    note:
      "Honesty rename: 'sprint' was the legacy term for what v5.31+ calls 'epic'. " +
      'The 5.31.0 resolver read the legacy key with a deprecation warning; ' +
      'v6.0.0 removes the fallback entirely. The migration tool moves the ' +
      "value here first so the next entry's removal of `epicClose` " +
      'sees the unified key.',
  }),

  // -------------------------------------------------------------------------
  // v5.40.0 (Epic #1142) — SDL critical-path consolidation
  // -------------------------------------------------------------------------
  Object.freeze({
    from: 'agentSettings.epicClose.runRetro',
    to: null,
    removedIn: '5.40.0',
    note:
      'The retro is always-on inside `/epic-deliver` Phase 5 starting in ' +
      '5.40.0; override with the `--skip-retro` CLI flag on a one-off basis. ' +
      'The entire `agentSettings.epicClose` block is removed; any sibling ' +
      'keys (e.g. `skipDocsFreshness`) carried no consumers and are dropped.',
  }),
  Object.freeze({
    // Catch-all sweep for any remaining keys under the deleted parent so
    // `additionalProperties: false` does not flag stragglers. The CLI walks
    // this entry as "if the parent path still exists after the explicit
    // child rewrites above, delete the parent".
    from: 'agentSettings.epicClose',
    to: null,
    removedIn: '5.40.0',
    note:
      'Sibling keys under the deleted `agentSettings.epicClose` block ' +
      '(e.g. `skipDocsFreshness`) are dropped along with the parent.',
  }),
  Object.freeze({
    from: 'agentSettings.riskGates.heuristics',
    to: 'agentSettings.planning.riskHeuristics',
    note:
      'Honesty rename: `riskGates` implied runtime gating that has not existed ' +
      'since v5.14. The heuristics array moved under `planning` where the ' +
      'decomposer system prompt actually consumes it. Same shape; same ' +
      'consumer; rename only.',
  }),
  Object.freeze({
    from: 'agentSettings.riskGates',
    to: null,
    removedIn: '5.40.0',
    note:
      'Parent of the renamed `heuristics` key. Removed after its single ' +
      'child has been relocated so the v6 schema rejects the stale parent.',
  }),
  Object.freeze({
    from: 'orchestration.hitl',
    to: null,
    removedIn: '5.40.0',
    note: 'Empty placeholder block that carried no consumers. Removed outright.',
  }),
  Object.freeze({
    from: 'orchestration.executor',
    to: null,
    removedIn: '5.40.0',
    note:
      'Audited as unread by the runtime in 5.40 and removed from the schema. ' +
      'The `IExecutionAdapter` interface and `ManualDispatchAdapter` ship ' +
      'unchanged for downstream consumers; only the config key is gone.',
  }),

  // Three keys removed from inside `runners.epicRunner` BEFORE the block
  // itself is renamed below. Order matters: the value-level prunes must run
  // against the legacy path, then the whole block is moved to its new home.
  Object.freeze({
    from: 'orchestration.runners.epicRunner.idleTimeoutSec',
    to: null,
    removedIn: '5.40.0',
    note:
      'Subprocess fan-out machinery removed in v5.34; the per-runner idle ' +
      'timeout knob no longer has a consumer.',
  }),
  Object.freeze({
    from: 'orchestration.runners.epicRunner.pollIntervalSec',
    to: null,
    removedIn: '5.40.0',
    note:
      'Subprocess fan-out machinery removed in v5.34. Poll cadence is now ' +
      'in-process and not externally tunable.',
  }),
  Object.freeze({
    from: 'orchestration.runners.epicRunner.logsDir',
    to: null,
    removedIn: '5.40.0',
    note:
      'Subprocess fan-out logs no longer land on disk; the directory pointer ' +
      'has no consumer.',
  }),
  Object.freeze({
    from: 'orchestration.runners.epicRunner',
    to: 'orchestration.runners.deliverRunner',
    note:
      'Honesty rename of the runner block: the SDL critical path is ' +
      '`/epic-deliver` (one command), not `/epic-execute` (the legacy ' +
      'two-command path). The whole sub-block (`enabled`, `concurrencyCap`, ' +
      '`progressReportIntervalSec`) moves verbatim.',
  }),
  Object.freeze({
    from: 'orchestration.runners.closeRetry',
    to: 'orchestration.runners.storyMergeRetry',
    note:
      'Honesty rename: the retry was always for non-fast-forward push of the ' +
      'Story merge to the Epic, never for the Epic close itself.',
  }),

  // -------------------------------------------------------------------------
  // v6.0.0 (Epic #1184) — additive only; no further key renames at the
  // data level. The new `agentSettings.qualityFloors` block ships with
  // sensible defaults baked into the gate scripts, so a consumer that
  // does nothing inherits the v6 floor automatically. We do NOT seed a
  // block during migration — adding default-equivalent config to a
  // consumer's `.agentrc.json` would be the opposite of idempotent.
  // -------------------------------------------------------------------------
]);

/**
 * Convenience accessor for callers that want the rewrite entries
 * keyed by their legacy path. Returns a fresh map each call so the
 * caller can mutate without risking the shared table. Cheap — the
 * table is on the order of a dozen entries.
 *
 * @returns {Map<string, KeymapEntry>}
 */
export function keymapByFrom() {
  /** @type {Map<string, KeymapEntry>} */
  const out = new Map();
  for (const entry of V5_TO_V6_KEYMAP) {
    out.set(entry.from, entry);
  }
  return out;
}
