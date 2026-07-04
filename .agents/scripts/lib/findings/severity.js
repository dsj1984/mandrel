/**
 * lib/findings/severity.js — Canonical severity vocabulary for the findings core.
 *
 * Single source of truth for finding severity (Story #3816). Three modules in
 * the shared findings core previously each declared their own severity list —
 * `classify-finding.js` (`[unknown, low, medium, high, critical]`),
 * `promote-finding.js` (`SEVERITY_RANK` over `[critical … info]`), and the
 * `qa-ledger` JSON schema (`[critical, high, medium, low, info]`). Because
 * `severity` is a `fingerprintFinding` identity field
 * (`route-finding.js`), the same finding could hash to different SHAs depending
 * on which path normalised its severity, silently weakening dedup. This module
 * collapses all three onto one enum + one normaliser so the fingerprint is
 * stable regardless of the code path that produced the severity.
 *
 * The canonical order is `critical | high | medium | low | info`, highest →
 * lowest, and it MUST match the `severity` enum in
 * `.agents/schemas/qa-ledger.schema.json`. Pure module: no I/O, no
 * module-level state beyond the frozen constants.
 */

/**
 * The closed, canonical set of severity values, ordered highest → lowest.
 * This is the ONLY definition of the severity vocabulary in the findings core;
 * `classify-finding.js` and `promote-finding.js` re-export / import it rather
 * than re-declaring their own list. Mirrors the `severity` enum in
 * `qa-ledger.schema.json`.
 */
export const SEVERITIES = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

/**
 * The severity applied when a finding carries no recognisable severity. `info`
 * is the canonical floor (lowest level). The ledger/finding schemas REQUIRE a
 * severity drawn from {@link SEVERITIES}, so this fallback only fires on
 * malformed input — and because both the classify and promote paths share it,
 * malformed input still fingerprints identically across the two paths.
 */
export const DEFAULT_SEVERITY = 'info';

const SEVERITY_SET = new Set(SEVERITIES);

/**
 * Numeric rank for "highest severity wins" comparisons, derived from the
 * canonical order so the ranking has exactly one source. `critical` is the
 * highest rank (`SEVERITIES.length - 1`); `info` is `0`.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const SEVERITY_RANK = Object.freeze(
  Object.fromEntries(
    SEVERITIES.map((severity, index) => [
      severity,
      SEVERITIES.length - 1 - index,
    ]),
  ),
);

/**
 * Normalise an arbitrary severity input to one of {@link SEVERITIES}. Case- and
 * whitespace-insensitive. A non-string, empty, or unrecognised value resolves
 * to `fallback` (default {@link DEFAULT_SEVERITY}) rather than throwing — the
 * findings pipeline treats severity as advisory signal, never a hard gate.
 *
 * @param {unknown} value — the raw severity field off a finding/ledger item.
 * @param {string} [fallback=DEFAULT_SEVERITY] — canonical value to return when
 *   `value` is absent or unrecognised.
 * @returns {string} one of {@link SEVERITIES}.
 */
export function normalizeSeverity(value, fallback = DEFAULT_SEVERITY) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return SEVERITY_SET.has(normalized) ? normalized : fallback;
}

/**
 * The highest-ranked severity across a list of raw severity values. Returns
 * {@link DEFAULT_SEVERITY} for an empty list. Each value is normalised through
 * {@link normalizeSeverity}, so the result is always one of {@link SEVERITIES}.
 *
 * @param {Iterable<unknown>} values — raw severity strings (or anything
 *   `normalizeSeverity` accepts).
 * @returns {string} one of {@link SEVERITIES}.
 */
export function highestSeverity(values) {
  let best = DEFAULT_SEVERITY;
  let bestRank = -1;
  for (const value of values) {
    const severity = normalizeSeverity(value);
    const rank = SEVERITY_RANK[severity];
    if (rank > bestRank) {
      bestRank = rank;
      best = severity;
    }
  }
  return best;
}
