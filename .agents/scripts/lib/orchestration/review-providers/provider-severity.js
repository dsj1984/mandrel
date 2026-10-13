/**
 * review-providers/provider-severity.js — the severity vocabulary shared by
 * the LLM-backed providers.
 *
 * @typedef {import('./types.js').Severity} Severity
 */

/**
 * Severity vocabulary shared by the LLM-backed providers (case-insensitive
 * token → canonical `Severity`); an unnamed token falls through to
 * `'suggestion'` in each provider's mapper.
 *
 * @type {Readonly<Record<string, Severity>>}
 */
export const PROVIDER_SEVERITY_MAP = Object.freeze({
  blocker: 'critical',
  critical: 'critical',
  fatal: 'critical',
  major: 'high',
  high: 'high',
  error: 'high',
  minor: 'medium',
  medium: 'medium',
  warning: 'medium',
  info: 'suggestion',
  nit: 'suggestion',
  style: 'suggestion',
  suggestion: 'suggestion',
  note: 'suggestion',
});
