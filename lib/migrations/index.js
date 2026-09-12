// lib/migrations/index.js
/**
 * Version-keyed migration runner.
 *
 * A migration is a one-time, version-gated transformation of a consumer
 * project's on-disk state (config shape, baseline layout, materialized
 * `.agents/` tree, …). When a consumer upgrades `mandrel` across a
 * version boundary that changed a contract (see
 * `.agents/rules/git-conventions.md` § Contract Cutovers), the upgrade path
 * runs every migration whose `version` falls inside the upgrade range so the
 * consumer's working tree matches the new release.
 *
 * The engine here is deliberately content-free: it owns ordering, version
 * filtering, idempotency enforcement, and the actionable log line. The
 * `migrations` registry is the single source of truth for which steps exist
 * and in what order they run.
 *
 * ## Step shape
 *
 * Each entry in `migrations` is:
 *
 * ```js
 * {
 *   version: '1.4.0',                  // semver the step graduates the tree to
 *   description: 'rename foo to bar',  // short, operator-facing summary
 *   detect(ctx) { return boolean },    // true ⇒ this step still needs applying
 *   apply(ctx) { ... },                // perform the change (mutates ctx state)
 * }
 * ```
 *
 * ## Idempotency contract
 *
 * `detect(ctx)` MUST return `false` once `apply(ctx)` has run against the same
 * context. The runner consults `detect` before every `apply`, so a step whose
 * change is already present is skipped. This makes a second `runMigrations`
 * pass over the same context a no-op — the property the unit test asserts.
 *
 * ## Version filtering
 *
 * `runMigrations({ fromVersion, toVersion, ctx })` applies only steps whose
 * `version` is strictly greater than `fromVersion` and less than or equal to
 * `toVersion`, in ascending version order. A step at exactly `fromVersion` is
 * already in the tree (the consumer was on that version) and is skipped; a
 * step at exactly `toVersion` is the target and runs.
 *
 * v2.0.0's Story-collapse cutover did not register a config migration step
 * (consumers wipe/re-sync `.agents/` and re-seed `.agentrc.json` from the
 * starter). Story #4531 registered the first real step — see
 * `steps/2.1.0-retire-mi-drop-knobs.js` — alongside the fixture steps in
 * `__tests__/index.test.js` that prove the machinery independent of any
 * real step. When the next contract cutover lands, add its step here
 * (ascending by version) with an idempotent `detect`/`apply`.
 */

import { compareVersions } from '../cli/version-helpers.js';
import { retireMiDropKnobs } from './steps/2.1.0-retire-mi-drop-knobs.js';
import { retireVerifyConcurrencyCap } from './steps/2.1.0-retire-verify-concurrency-cap.js';
import { retireEpicAcTags } from './steps/2.2.0-retire-epic-ac-tags.js';
import { retireMaxSeedWords } from './steps/2.11.0-retire-max-seed-words.js';
import { retireCodebaseSnapshot } from './steps/2.20.0-retire-codebase-snapshot.js';
import { retireLintBaselineCommand } from './steps/2.32.0-retire-lint-baseline-command.js';
import { retireDeliveryLimitKnobs } from './steps/2.57.0-retire-delivery-limit-knobs.js';
import { retirePlanningLimitKnobs } from './steps/2.57.0-retire-planning-limit-knobs.js';

/**
 * Ordered registry of migration steps. MUST stay sorted ascending by
 * `version`.
 *
 * @type {Array<{
 *   version: string,
 *   description: string,
 *   detect: (ctx: unknown) => boolean,
 *   apply: (ctx: unknown) => void,
 * }>}
 */
export const migrations = [
  retireMiDropKnobs,
  retireVerifyConcurrencyCap,
  retireEpicAcTags,
  retireMaxSeedWords,
  retireCodebaseSnapshot,
  retireLintBaselineCommand,
  retirePlanningLimitKnobs,
  retireDeliveryLimitKnobs,
];

/**
 * The version ordering every migration decision uses.
 *
 * Re-exported from `lib/cli/version-helpers.js` — the dependency-free leaf
 * that owns the canonical `parseVersion` / `compareVersions` pair (Story
 * #4048 B3). The runner previously carried its own copy, so an ordering fix
 * had to be made in three places or the copies drifted apart. Re-exporting
 * rather than moving keeps this module's public surface intact for the
 * callers that import `compareVersions` from here.
 */
export { compareVersions };

/**
 * The steps that apply for an upgrade, in the order they must run:
 * `fromVersion < step.version <= toVersion`, ascending.
 *
 * Exported because `mandrel migrate --dry-run` has to preview exactly what the
 * live run would do. That preview previously re-implemented this filter and
 * carried a comment promising it "mirrors the runner's own comparator" — a
 * sync obligation nothing enforced, and the reason a third `compareVersions`
 * copy existed. One selector means the preview cannot drift from the run.
 *
 * @param {{ registry?: Array<object>, fromVersion: string, toVersion: string }} params
 * @returns {Array<object>}
 */
export function selectStepsInRange({
  registry = migrations,
  fromVersion,
  toVersion,
}) {
  return registry
    .filter(
      (step) =>
        compareVersions(step.version, fromVersion) > 0 &&
        compareVersions(step.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Run the version-keyed migrations between two versions.
 *
 * Steps are filtered to `fromVersion < version <= toVersion`, sorted ascending
 * by version, and applied in order. Before each `apply`, the step's `detect`
 * is consulted: a step whose change is already present (detect returns false)
 * is skipped, which is what makes a repeat pass a no-op. Every step that
 * actually applies prints `migrated <version>: <description>` through the
 * injected `log` seam.
 *
 * @param {object} params
 * @param {string} params.fromVersion - Version the tree is currently on
 *   (exclusive lower bound).
 * @param {string} params.toVersion - Version the tree is upgrading to
 *   (inclusive upper bound).
 * @param {unknown} params.ctx - Opaque context threaded to each step's
 *   `detect`/`apply`. Migrations mutate this to record their change.
 * @param {(message: string) => void} [params.log] - Log seam for the
 *   actionable per-step line. Defaults to `console.log`. Injected by tests so
 *   no real stdout write occurs.
 * @param {Array<{
 *   version: string,
 *   description: string,
 *   detect: (ctx: unknown) => boolean,
 *   apply: (ctx: unknown) => void,
 * }>} [params.registry] - Step registry. Defaults to the module `migrations`
 *   array; injected by tests with fixture steps.
 * @returns {{ applied: string[], skipped: string[] }} The versions that
 *   applied and those that were in-range but skipped because `detect` returned
 *   false.
 */
export function runMigrations({
  fromVersion,
  toVersion,
  ctx,
  log = console.log,
  registry = migrations,
} = {}) {
  const inRange = selectStepsInRange({ registry, fromVersion, toVersion });

  const applied = [];
  const skipped = [];

  for (const step of inRange) {
    if (!step.detect(ctx)) {
      skipped.push(step.version);
      continue;
    }
    step.apply(ctx);
    log(`migrated ${step.version}: ${step.description}`);
    applied.push(step.version);
  }

  return { applied, skipped };
}

export default runMigrations;
