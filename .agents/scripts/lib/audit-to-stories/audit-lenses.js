/**
 * SSOT for the audit lens names. `audit::<lens>` labels key off these (via
 * each finding's report basename), never off a finding's `dimension` text.
 * Pure.
 */

/**
 * One per `/audit-<lens>` workflow that emits `audit-<lens>-results.md`; a
 * new `audit-*` lens workflow MUST be added here.
 *
 * @type {ReadonlyArray<string>}
 */
export const AUDIT_LENSES = Object.freeze([
  'accessibility',
  'architecture',
  'baselines',
  'clean-code',
  'data-model',
  'dependencies',
  'devops',
  'documentation',
  'mobile',
  'navigability',
  'performance',
  'privacy',
  'quality',
  'security',
  'seo',
  'sre',
  'ux-ui',
]);

const LENS_SET = new Set(AUDIT_LENSES);

/**
 * @param {string} lens
 * @returns {boolean} true when `lens` is one of the canonical {@link AUDIT_LENSES}.
 */
export function isCanonicalLens(lens) {
  return LENS_SET.has(lens);
}

/**
 * Basename-only, either separator. `null` for a non-matching or non-canonical
 * name, so a stray report can never mint a junk label.
 *
 * @param {unknown} sourceReport — e.g. `temp/audits/audit-clean-code-results.md`.
 * @returns {string|null} the canonical lens (`clean-code`) or `null`.
 */
export function lensFromSourceReport(sourceReport) {
  if (typeof sourceReport !== 'string' || sourceReport.length === 0) {
    return null;
  }
  const normalised = sourceReport.replace(/\\/g, '/');
  const base = normalised.slice(normalised.lastIndexOf('/') + 1);
  const match = base.match(/^audit-(.+)-results\.md$/);
  if (!match) return null;
  const lens = match[1];
  return isCanonicalLens(lens) ? lens : null;
}

/**
 * @param {Array<{ sourceReport?: unknown }>} findings
 * @returns {string[]} sorted, deduped `audit::<lens>` labels.
 */
export function auditLabelsForFindings(findings) {
  const lenses = new Set();
  for (const finding of findings ?? []) {
    const lens = lensFromSourceReport(finding?.sourceReport);
    if (lens) lenses.add(lens);
  }
  return [...lenses].sort().map((lens) => `audit::${lens}`);
}
