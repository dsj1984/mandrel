// lib/migrations/index.js
/**
 * Version-keyed migration runner.
 *
 * A migration is a one-time, version-gated transformation of a consumer
 * project's on-disk state (config shape, baseline layout, materialized
 * `.agents/` tree, …). When a consumer upgrades `@mandrelai/agents` across a
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
 * The registry currently ships empty: the project sits on the 1.x line under
 * release-please `always-bump-minor`, and no real config break has landed yet.
 * The machinery is proven by the fixture steps in
 * `__tests__/index.test.js`. When the first real contract cutover lands, add
 * its step here (ascending by version) with an idempotent `detect`/`apply`.
 */

/**
 * Ordered registry of migration steps. MUST stay sorted ascending by
 * `version`. Empty until the first real contract cutover graduates a step
 * here.
 *
 * @type {Array<{
 *   version: string,
 *   description: string,
 *   detect: (ctx: unknown) => boolean,
 *   apply: (ctx: unknown) => void,
 * }>}
 */
export const migrations = [];

/**
 * Parse a dotted semver-ish string into a numeric tuple for comparison.
 * Non-numeric or missing segments coerce to 0 so a partial version
 * (`'1.4'`) still compares sanely against a full one (`'1.4.0'`).
 *
 * @param {string} version
 * @returns {[number, number, number]}
 */
function parseVersion(version) {
  const [major, minor, patch] = String(version).split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

/**
 * Compare two version strings. Returns a negative number when `a < b`, zero
 * when equal, and a positive number when `a > b` — the standard `Array.sort`
 * comparator contract.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
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
  const inRange = registry
    .filter(
      (step) =>
        compareVersions(step.version, fromVersion) > 0 &&
        compareVersions(step.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));

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
