/**
 * Shared bounded-retry / anti-thrash / escalation loop for /epic-deliver
 * Phase 4 (epic-audit) and Phase 5 (code-review). The two phase helpers
 * supply phase-specific `applyFix`, `rescan`, and `validate` hooks; this
 * module owns the control flow:
 *
 *   1. Walk findings in input order. For each finding:
 *      a. Run `classify(finding)`. If the class is one of the safety
 *         escalation classes (`spec-deviation`, `secrets`, `test-deletion`,
 *         `scope-exceeded`), route to `escalated[]` without calling
 *         `applyFix`.
 *      b. Otherwise, attempt up to `attemptCeiling` fixes:
 *         - Call `applyFix(finding, attempt)`; capture the returned
 *           commit / file list.
 *         - If the fix would touch more than `scopeCap` files, treat as
 *           `scope-exceeded` and escalate without staging the change.
 *         - Call `validate(finding, fixResult)`. On regression, mark the
 *           finding as a `validation-regression` escalation and stop
 *           retrying it.
 *         - Call `rescan(finding)`. If the same stable ID resurfaces,
 *           record one anti-thrash strike. After two strikes (the fix did
 *           not move the needle) mark the finding `thrash-blocked` and
 *           stop retrying.
 *         - Otherwise mark the finding fixed and move on.
 *      c. If the attempt loop exhausts without fixing the finding, mark
 *         it `ceiling-exhausted` and escalate.
 *
 * The module is intentionally pure: no I/O, no logging side effects. All
 * git, commit, and lint plumbing lives in the caller's hooks so the loop
 * can be unit-tested with deterministic fakes.
 *
 * See Epic #2586 / Tech Spec #2588 § "Auto-fix loop semantics" for the
 * canonical specification.
 */

/**
 * Escalation classes routed directly to `escalated[]` without invoking
 * `applyFix`. The set is frozen so consumers cannot mutate it at runtime.
 */
export const SAFETY_ESCALATION_CLASSES = Object.freeze(
  new Set(['spec-deviation', 'secrets', 'test-deletion', 'scope-exceeded']),
);

/**
 * Escalation reasons surfaced by the loop itself (not from `classify`).
 */
export const LOOP_ESCALATION_REASONS = Object.freeze(
  new Set([
    'ceiling-exhausted',
    'thrash-detected',
    'validation-regression',
    'scope-exceeded',
  ]),
);

const DEFAULT_ATTEMPT_CEILING = 3;
const DEFAULT_SCOPE_CAP = 5;
const ANTI_THRASH_STRIKE_LIMIT = 1;

/**
 * @typedef {object} Finding
 * @property {string} id        Stable finding ID — used for anti-thrash.
 * @property {string} [title]   Optional human-readable title; opaque to the loop.
 * @property {string} [severity] Optional severity tag; opaque to the loop.
 */

/**
 * @typedef {object} FixResult
 * @property {string[]} [files]    Files the fix touched. Compared against `scopeCap`.
 * @property {string} [commitSha]  Optional SHA the fix committed at; opaque to the loop.
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok            `false` triggers a `validation-regression` escalation.
 * @property {string} [reason]       Optional reason surfaced on escalation.
 */

/**
 * @typedef {object} RescanResult
 * @property {boolean} stillPresent  True if the same finding ID resurfaced.
 */

/**
 * @typedef {object} LoopHooks
 * @property {(finding: Finding) => string} classify    Returns escalation class or "fixable".
 * @property {(finding: Finding, attempt: number) => FixResult | Promise<FixResult>} applyFix
 * @property {(finding: Finding) => RescanResult | Promise<RescanResult>} rescan
 * @property {(finding: Finding, fix: FixResult) => ValidationResult | Promise<ValidationResult>} validate
 */

/**
 * @typedef {object} LoopOptions
 * @property {Finding[]} findings
 * @property {number} [attemptCeiling]
 * @property {number} [scopeCap]
 * @property {(finding: Finding, attempt: number) => FixResult | Promise<FixResult>} applyFix
 * @property {(finding: Finding) => RescanResult | Promise<RescanResult>} rescan
 * @property {(finding: Finding, fix: FixResult) => ValidationResult | Promise<ValidationResult>} validate
 * @property {(finding: Finding) => string} classify
 */

/**
 * @typedef {object} EscalatedEntry
 * @property {Finding} finding
 * @property {string} reason      One of SAFETY_ESCALATION_CLASSES or LOOP_ESCALATION_REASONS.
 * @property {number} attempts    Attempts consumed before escalation.
 * @property {string} [detail]    Optional human-readable detail.
 */

/**
 * @typedef {object} FixedEntry
 * @property {Finding} finding
 * @property {number} attempts
 * @property {FixResult} fix
 */

/**
 * @typedef {object} ThrashBlockedEntry
 * @property {Finding} finding
 * @property {number} attempts
 */

/**
 * @typedef {object} LoopResult
 * @property {FixedEntry[]} fixed
 * @property {ThrashBlockedEntry[]} thrashBlocked
 * @property {EscalatedEntry[]} escalated
 */

/**
 * Validate caller-supplied options before entering the loop.
 *
 * @param {LoopOptions} opts
 * @returns {{ findings: Finding[], attemptCeiling: number, scopeCap: number,
 *            applyFix: Function, rescan: Function, validate: Function,
 *            classify: Function }}
 */
function normalizeOptions(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('runAutoFixLoop: options object is required');
  }
  const {
    findings,
    attemptCeiling = DEFAULT_ATTEMPT_CEILING,
    scopeCap = DEFAULT_SCOPE_CAP,
    applyFix,
    rescan,
    validate,
    classify,
  } = opts;

  if (!Array.isArray(findings)) {
    throw new Error('runAutoFixLoop: findings must be an array');
  }
  if (!Number.isInteger(attemptCeiling) || attemptCeiling < 0) {
    throw new Error(
      'runAutoFixLoop: attemptCeiling must be a non-negative integer',
    );
  }
  if (!Number.isInteger(scopeCap) || scopeCap < 1) {
    throw new Error('runAutoFixLoop: scopeCap must be a positive integer');
  }
  for (const [name, fn] of [
    ['applyFix', applyFix],
    ['rescan', rescan],
    ['validate', validate],
    ['classify', classify],
  ]) {
    if (typeof fn !== 'function') {
      throw new Error(`runAutoFixLoop: ${name} must be a function`);
    }
  }

  return {
    findings,
    attemptCeiling,
    scopeCap,
    applyFix,
    rescan,
    validate,
    classify,
  };
}

/**
 * Drive the bounded-retry auto-fix loop.
 *
 * The hooks may be sync or async — the loop awaits each return value, so
 * callers can plumb in real git / lint / test runners without ceremony.
 *
 * @param {LoopOptions} opts
 * @returns {Promise<LoopResult>}
 */
export async function runAutoFixLoop(opts) {
  const {
    findings,
    attemptCeiling,
    scopeCap,
    applyFix,
    rescan,
    validate,
    classify,
  } = normalizeOptions(opts);

  /** @type {FixedEntry[]} */
  const fixed = [];
  /** @type {ThrashBlockedEntry[]} */
  const thrashBlocked = [];
  /** @type {EscalatedEntry[]} */
  const escalated = [];

  for (const finding of findings) {
    // Safety classification runs first — never call applyFix for these.
    const safetyClass = classify(finding);
    if (SAFETY_ESCALATION_CLASSES.has(safetyClass)) {
      escalated.push({
        finding,
        reason: safetyClass,
        attempts: 0,
      });
      continue;
    }

    let attempts = 0;
    let thrashStrikes = 0;
    let resolution = null; // 'fixed' | 'thrash' | { reason, detail } | null

    while (attempts < attemptCeiling) {
      attempts += 1;
      const fix = await applyFix(finding, attempts);

      // Scope-cap guard — escalate without validating.
      if (Array.isArray(fix?.files) && fix.files.length > scopeCap) {
        resolution = {
          reason: 'scope-exceeded',
          detail: `fix touched ${fix.files.length} files (cap=${scopeCap})`,
          fix,
        };
        break;
      }

      const validation = await validate(finding, fix);
      if (!validation || validation.ok !== true) {
        resolution = {
          reason: 'validation-regression',
          detail: validation?.reason,
          fix,
        };
        break;
      }

      const scan = await rescan(finding);
      if (scan && scan.stillPresent === true) {
        thrashStrikes += 1;
        if (thrashStrikes > ANTI_THRASH_STRIKE_LIMIT) {
          resolution = { reason: 'thrash-detected', fix };
          break;
        }
        // Same finding survived — let the next attempt try a different fix.
        continue;
      }

      // Finding cleared.
      resolution = { kind: 'fixed', fix };
      break;
    }

    if (resolution && resolution.kind === 'fixed') {
      fixed.push({ finding, attempts, fix: resolution.fix });
      continue;
    }

    if (resolution && resolution.reason === 'thrash-detected') {
      thrashBlocked.push({ finding, attempts });
      continue;
    }

    if (resolution?.reason) {
      escalated.push({
        finding,
        reason: resolution.reason,
        attempts,
        detail: resolution.detail,
      });
      continue;
    }

    // Attempt loop exhausted without a verdict — ceiling reached.
    escalated.push({
      finding,
      reason: 'ceiling-exhausted',
      attempts,
    });
  }

  return { fixed, thrashBlocked, escalated };
}
