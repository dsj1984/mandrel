/**
 * lib/audit-to-stories/audit-lenses.js — SSOT for the canonical audit lens
 * taxonomy.
 *
 * The `/audit-<lens>` workflows each emit a report named
 * `audit-<lens>-results.md`. The `audit::<lens>` GitHub label set is keyed off
 * exactly these lens names — never off a finding's fine-grained `dimension`
 * text. `build-story-body.js` derives a group's `audit::<lens>` labels from
 * each finding's `sourceReport` basename via {@link lensFromSourceReport}, and
 * `audit-labels-bootstrap.js` creates one `audit::<lens>` label per entry in
 * {@link AUDIT_LENSES}. Centralising the list here keeps the label producer
 * (bootstrap) and the label deriver (story-body) from drifting apart.
 *
 * Pure: no I/O.
 *
 * @see Story #4195 — junk `audit::<dimension>` label derivation.
 */

/**
 * The canonical lens names, one per `/audit-<lens>` workflow under
 * `.agents/workflows/` (excluding the `audit-to-stories` and `audit-fan-out`
 * meta-workflows, which produce no `audit-<lens>-results.md` of their own).
 * Adding a new `audit-*` workflow MUST add its lens name here.
 *
 * @type {ReadonlyArray<string>}
 */
export const AUDIT_LENSES = Object.freeze([
  'accessibility',
  'architecture',
  'clean-code',
  'data-model',
  'dependencies',
  'devops',
  'documentation',
  'navigability',
  'performance',
  'privacy',
  'quality',
  'security',
  'seo',
  'sre',
  'ux-ui',
]);

/** O(1) membership set for {@link isCanonicalLens}. */
const LENS_SET = new Set(AUDIT_LENSES);

/**
 * @param {string} lens
 * @returns {boolean} true when `lens` is one of the canonical {@link AUDIT_LENSES}.
 */
export function isCanonicalLens(lens) {
  return LENS_SET.has(lens);
}

/**
 * Derive the canonical lens name from an `audit-<lens>-results.md` source
 * report path. The derivation is basename-only (the directory — typically
 * `temp/audits/` — is irrelevant) and matches the exact
 * `audit-<lens>-results.md` shape the audit workflows emit. Backslash and
 * forward-slash separators are both handled so a Windows-authored path
 * resolves identically.
 *
 * Returns `null` when the path does not match the expected shape or the
 * extracted lens is not one of the canonical {@link AUDIT_LENSES} — callers
 * drop a `null` so a stray report name can never mint a junk `audit::*` label.
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
 * Derive the deduped, sorted set of canonical `audit::<lens>` labels for a
 * collection of findings, keyed off each finding's `sourceReport` basename.
 * Findings whose `sourceReport` does not resolve to a canonical lens
 * contribute no label (never a junk one). Multi-lens groups (findings from
 * more than one report) yield one label per distinct lens.
 *
 * @param {Array<{ sourceReport?: unknown }>} findings
 * @returns {string[]} sorted `audit::<lens>` labels.
 */
export function auditLabelsForFindings(findings) {
  const lenses = new Set();
  for (const finding of findings ?? []) {
    const lens = lensFromSourceReport(finding?.sourceReport);
    if (lens) lenses.add(lens);
  }
  return [...lenses].sort().map((lens) => `audit::${lens}`);
}
