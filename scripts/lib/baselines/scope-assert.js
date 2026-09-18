// scripts/lib/baselines/scope-assert.js
//
// Story #5012 — the pure both-directions row-set assertion, plus the
// merge-base attribution that decides which half of a divergence is this
// change set's fault.
//
// `check-baselines.js` answers "did a measured value regress?". Nothing
// answered "does this baseline still describe the tree?" — so a row could
// point at a file deleted six months ago, or an in-scope file could carry no
// row at all, and every gate stayed green. Both directions are checked here:
//
//   - **missing** — an in-scope file with no row. Only asserted for kinds
//     whose producer emits one row per in-scope file
//     (`scope-inventory.js#KIND_SCOPE_POLICY`).
//   - **extra** — a row whose file is gone from disk (`absent`) or no longer
//     matched by the gate's own `targetDirs` / `ignoreGlobs` (`out-of-scope`).
//
// ## Why attribution exists
//
// Whole-tree equality on the PR path is unusable: the moment anyone lands an
// in-scope file, every open PR reds on divergence its author did not create
// and cannot fix from their branch. So the gate blocks only on divergence
// attributable to `merge-base(base, HEAD)..HEAD`, and reports the inherited
// remainder as a warning that costs nothing to carry.
//
// Attribution can be wrong in one safe direction only, so the resolution
// **fails towards strict**: no resolvable base, a HEAD not ahead of its base,
// or a change set that edits a baseline or the config defining its scope all
// promote every finding to fatal. The last case is the load-bearing one — once
// a branch has rewritten the scope rules themselves, "which side of the
// merge-base introduced this row" is no longer a question the diff can answer.
//
// Pure module: no filesystem, no git, no config resolution. Every input is
// handed in already resolved, which is what lets the whole attribution matrix
// be unit-tested without a fixture repository.

/** A row whose keyed file no longer exists on disk. */
const REASON_ABSENT = 'absent';
/** A row whose file exists but is no longer inside the gate's scope. */
const REASON_OUT_OF_SCOPE = 'out-of-scope';

export const EXTRA_REASONS = Object.freeze({
  ABSENT: REASON_ABSENT,
  OUT_OF_SCOPE: REASON_OUT_OF_SCOPE,
});

/**
 * Strictness reasons, in resolution order. Exported so the CLI can render the
 * cause without restating the strings.
 */
export const STRICT_REASONS = Object.freeze({
  NO_BASE: 'no-resolvable-base',
  NOT_AHEAD: 'head-not-ahead-of-base',
  BASELINE_EDITED: 'change-set-edits-a-baseline',
  SCOPE_CONFIG_EDITED: 'change-set-edits-a-scope-config',
  ATTRIBUTABLE: 'attributable-to-merge-base-range',
});

/**
 * Collect the distinct key values a row set carries, skipping malformed rows.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} keyField
 * @returns {Set<string>}
 */
function rowKeys(rows, keyField) {
  const keys = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row?.[keyField];
    if (typeof value === 'string' && value.length > 0) keys.add(value);
  }
  return keys;
}

/**
 * Compare a baseline's row set against its in-scope inventory.
 *
 * Direction gating is the inventory's call, not this function's: a kind whose
 * policy omits `missing` produces no missing findings even when its row set is
 * far sparser than the tree, because for that kind sparseness is correct.
 *
 * @param {{
 *   inventory: { kind: string, keyField: string, directions: readonly string[],
 *     files: string[] | null, degraded: boolean, reason: string | null },
 *   rows: Array<Record<string, unknown>>,
 *   existsOnDisk?: (relPath: string) => boolean,
 * }} params
 * @returns {{
 *   kind: string,
 *   skipped: boolean,
 *   reason: string | null,
 *   missing: string[],
 *   extra: Array<{ path: string, reason: string }>,
 * }}
 */
export function assertScope({ inventory, rows, existsOnDisk } = {}) {
  const kind = inventory?.kind ?? 'unknown';
  const directions = inventory?.directions ?? [];
  if (directions.length === 0 || inventory?.files === null) {
    return {
      kind,
      skipped: true,
      reason: inventory?.reason ?? `${kind} declares no assertable direction`,
      missing: [],
      extra: [],
    };
  }

  const keyField = inventory.keyField;
  const inScope = new Set(inventory.files);
  const keyed = rowKeys(rows, keyField);
  const onDisk = typeof existsOnDisk === 'function' ? existsOnDisk : () => true;

  const missing = directions.includes('missing')
    ? inventory.files.filter((file) => !keyed.has(file)).sort()
    : [];

  const extra = [];
  if (directions.includes('extra')) {
    for (const key of [...keyed].sort()) {
      if (inScope.has(key)) continue;
      extra.push({
        path: key,
        reason: onDisk(key) ? REASON_OUT_OF_SCOPE : REASON_ABSENT,
      });
    }
  }

  return { kind, skipped: false, reason: null, missing, extra };
}

/**
 * Decide whether this run blocks on every finding or only on the attributable
 * ones. Fails towards strict — each early return below is a case where the
 * merge-base range cannot be trusted to explain the divergence.
 *
 * @param {{
 *   base?: string | null,
 *   aheadOfBase?: boolean,
 *   changedFiles?: string[],
 *   baselinePaths?: string[],
 *   scopeConfigPaths?: string[],
 * }} params
 * @returns {{ strict: boolean, reason: string }}
 */
export function resolveStrictness({
  base,
  aheadOfBase,
  changedFiles = [],
  baselinePaths = [],
  scopeConfigPaths = [],
} = {}) {
  if (typeof base !== 'string' || base.length === 0) {
    return { strict: true, reason: STRICT_REASONS.NO_BASE };
  }
  if (aheadOfBase !== true) {
    return { strict: true, reason: STRICT_REASONS.NOT_AHEAD };
  }
  const changed = new Set(changedFiles);
  if (baselinePaths.some((file) => changed.has(file))) {
    return { strict: true, reason: STRICT_REASONS.BASELINE_EDITED };
  }
  if (scopeConfigPaths.some((file) => changed.has(file))) {
    return { strict: true, reason: STRICT_REASONS.SCOPE_CONFIG_EDITED };
  }
  return { strict: false, reason: STRICT_REASONS.ATTRIBUTABLE };
}

/**
 * Split a kind's findings into the fatal set and the warning set.
 *
 * Under `strict`, everything is fatal. Otherwise a finding is fatal only when
 * this change set created it:
 *
 *   - a **missing** row for a file the range ADDED — the branch introduced an
 *     in-scope file and left it unmeasured;
 *   - an **extra** row for a file the range DELETED or renamed away — the
 *     branch removed the file and left its row behind.
 *
 * Everything else is inherited: real, worth reporting, and not this author's
 * to fix from this branch.
 *
 * @param {{
 *   missing?: string[],
 *   extra?: Array<{ path: string, reason: string }>,
 *   added?: string[],
 *   removed?: string[],
 *   strict?: boolean,
 * }} params
 * @returns {{
 *   fatal: { missing: string[], extra: Array<{ path: string, reason: string }> },
 *   warning: { missing: string[], extra: Array<{ path: string, reason: string }> },
 *   fatalCount: number,
 *   warningCount: number,
 * }}
 */
export function attributeDivergence({
  missing = [],
  extra = [],
  added = [],
  removed = [],
  strict = false,
} = {}) {
  const addedSet = new Set(added);
  const removedSet = new Set(removed);
  const isFatalMissing = (file) => strict || addedSet.has(file);
  const isFatalExtra = (finding) => strict || removedSet.has(finding.path);

  const fatal = {
    missing: missing.filter(isFatalMissing),
    extra: extra.filter(isFatalExtra),
  };
  const warning = {
    missing: missing.filter((file) => !isFatalMissing(file)),
    extra: extra.filter((finding) => !isFatalExtra(finding)),
  };
  return {
    fatal,
    warning,
    fatalCount: fatal.missing.length + fatal.extra.length,
    warningCount: warning.missing.length + warning.extra.length,
  };
}
