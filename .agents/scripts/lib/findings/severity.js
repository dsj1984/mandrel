/**
 * lib/findings/severity.js — the one severity vocabulary. Severity is a
 * fingerprint field, so every path must normalise it identically. Order MUST
 * match the `severity` enum in `qa-ledger.schema.json`.
 */

/** Highest → lowest. */
export const SEVERITIES = Object.freeze([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);

const DEFAULT_SEVERITY = 'info';

const SEVERITY_SET = new Set(SEVERITIES);

/** @type {Readonly<Record<string, string>>} */
const SEVERITY_ALIASES = Object.freeze({
  blocker: 'critical',
  major: 'high',
  mod: 'medium',
  moderate: 'medium',
  minor: 'low',
  informational: 'info',
  nit: 'info',
  trivial: 'info',
});

/** @type {Readonly<Record<string, number>>} */
export const SEVERITY_RANK = Object.freeze(
  Object.fromEntries(
    SEVERITIES.map((severity, index) => [
      severity,
      SEVERITIES.length - 1 - index,
    ]),
  ),
);

/**
 * Never throws — severity is advisory, never a gate.
 *
 * @param {unknown} value
 * @param {string} [fallback=DEFAULT_SEVERITY]
 * @returns {string}
 */
export function normalizeSeverity(value, fallback = DEFAULT_SEVERITY) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (SEVERITY_SET.has(normalized)) return normalized;
  return SEVERITY_ALIASES[normalized] ?? fallback;
}

/**
 * Fingerprint-only projection: absent stays `''` and unknown passes through,
 * so no filed fingerprint moves; aliases resolve, so the hash is invariant
 * under normalisation.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprintSeverity(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().toLowerCase();
  if (raw.length === 0) return '';
  return normalizeSeverity(raw, raw);
}

/**
 * @param {Iterable<unknown>} values
 * @returns {string}
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

/** Test-only: the alias-table invariant is unobservable via the API. */
export const __testing = {
  DEFAULT_SEVERITY,
  SEVERITY_ALIASES,
};
