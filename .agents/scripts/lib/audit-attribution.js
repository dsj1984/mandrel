/**
 * audit-attribution.js — decide whose defect a red advisory check is.
 *
 * `npm audit` reports the advisories present in a dependency tree; it says
 * nothing about who introduced them. Advisories are published against
 * packages that are ALREADY installed, so `main` goes red between pull
 * requests without anybody's diff causing it, and the first PR opened
 * afterwards becomes the discovery mechanism — its author debugging a
 * supply-chain advisory from inside a failing log that has nothing to do
 * with their change.
 *
 * The nightly sweep (`.github/workflows/dependency-audit-cron.yml`) shrinks
 * how often that happens; it cannot make the failure legible when it does.
 * An advisory published after one night's sweep and before the next lands on
 * whoever opens a PR in between. This module supplies the missing sentence:
 * the same audit, evaluated against the pull request's merge base.
 *
 * It buys legibility, never permission — see `attributionExitCode`.
 */

/** The pull request's own diff introduced the advisory. */
export const INTRODUCED = 'introduced-by-this-diff';
/** The merge base carries it too; the diff is innocent. */
export const PRE_EXISTING = 'pre-existing';
/** The probe could not reach a verdict. Never an accusation. */
export const UNKNOWN = 'unknown';

/**
 * Decide the verdict from the two audit outcomes.
 *
 * Pure — the caller owns running the audits. `baseAudit` is `null` when the
 * base could not be audited at all, which is the `unknown` path: an
 * attribution mechanism must never guess, because the guess it would make
 * (`introduced-by-this-diff`) is an accusation against the author reading it.
 *
 * @param {{ headFailed: boolean, baseAudit: { failed: boolean } | null }} input
 * @returns {string} one of INTRODUCED / PRE_EXISTING / UNKNOWN
 */
export function deriveVerdict({ headFailed, baseAudit }) {
  if (!headFailed) return UNKNOWN;
  if (!baseAudit || typeof baseAudit.failed !== 'boolean') return UNKNOWN;
  return baseAudit.failed ? PRE_EXISTING : INTRODUCED;
}

/**
 * The exit code a verdict earns.
 *
 * **Both real verdicts fail.** The advisory is genuine either way: a check
 * that passed on `pre-existing` would let advisories accumulate on `main`
 * unnoticed, which is the exact failure the nightly sweep exists to prevent.
 * Attribution changes what the log says, never whether the branch may land.
 *
 * `unknown` exits 0 — the probe degraded, and the required `npm audit` step
 * has already failed on its own account. A reporter that can turn a red into
 * a second, unrelated red is worse than no reporter.
 *
 * @param {string} verdict
 * @returns {number}
 */
export function attributionExitCode(verdict) {
  return verdict === UNKNOWN ? 0 : 1;
}

/**
 * Render the operator-facing report for a verdict.
 *
 * `trackingIssue` is the open `meta::dependency-advisory` issue number when
 * the nightly sweep has already filed one, or `null`. Naming it is the point
 * of the `pre-existing` branch: it turns "why is my unrelated PR red" into a
 * link to the issue that already owns the fix.
 *
 * @param {{ verdict: string, baseRef?: string, trackingIssue?: number|null, reason?: string|null }} input
 * @returns {string[]} lines, in emission order
 */
export function renderAttribution({
  verdict,
  baseRef = null,
  trackingIssue = null,
  reason = null,
}) {
  const at = baseRef ? ` (merge base ${baseRef})` : '';
  if (verdict === PRE_EXISTING) {
    const lines = [
      `::warning::Advisory attribution: PRE-EXISTING${at}. The same high-severity advisory is already present on the merge base, so this pull request's diff did not introduce it.`,
      'This check still fails, and deliberately: the advisory is real, and letting it pass here would let advisories accumulate on `main` unnoticed.',
      "Fix it as a standalone `fix(deps)` PR against `main` rather than spending this Story's scope on it. Check the `overrides` block in package.json first — a pinned floor one patch below the patched release is the usual cause.",
    ];
    if (trackingIssue != null) {
      lines.splice(
        1,
        0,
        `The nightly sweep already filed the tracking issue: #${trackingIssue}.`,
      );
    }
    return lines;
  }
  if (verdict === INTRODUCED) {
    return [
      `::error::Advisory attribution: INTRODUCED BY THIS DIFF${at}. The merge base audits clean at the high-severity threshold, so a dependency change on this branch brought the advisory in.`,
      "Read the advisory's own version range before accepting a fix: `npm audit fix --force` often proposes a needless semver-major when the parent package's declared range already admits a patched version.",
    ];
  }
  return [
    `::warning::Advisory attribution: UNKNOWN${at}${reason ? ` — ${reason}` : ''}. The audit result above stands on its own; this probe adds nothing to it.`,
  ];
}
