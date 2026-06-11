/**
 * review-providers/parse-findings.js — shared JSON-findings parser.
 *
 * Story #3981 — extracts the verbatim-duplicated parsing logic from
 * `parseCodexFindings` (codex.js) and `parseSecurityReviewFindings`
 * (security-review.js) into one templated parser. Both adapters emit
 * JSON; the parser is liberal in what it accepts:
 *   - A bare array of finding objects.
 *   - An object with a `findings` array.
 *   - Either shape wrapped in an outer envelope with a `result` or
 *     `data` key (covers minor wire-format drift across versions
 *     without re-shimming).
 *
 * Each entry's severity is funnelled through the caller-supplied
 * `mapSeverity` so the canonical enum is the only thing that reaches
 * the renderer. Entries without a `title` or `body` are skipped — the
 * orchestrator cannot post an empty finding, and silently dropping the
 * entry is safer than fabricating one.
 *
 * Per-provider deltas ride in as options:
 *   - `errorPrefix`     — prefix for the JSON-parse failure message.
 *   - `mapSeverity`     — provider severity vocabulary → canonical enum.
 *   - `defaultCategory` — when set, entries missing a `category` get
 *     this value (security-review defaults to `'security'`); when
 *     omitted, `category` is only set when present (codex behavior).
 *
 * @typedef {import('./types.js').Finding}  Finding
 * @typedef {import('./types.js').Severity} Severity
 */

/**
 * Parse a provider's raw stdout into `Finding[]`.
 *
 * @param {string} rawStdout
 * @param {{
 *   errorPrefix: string,
 *   mapSeverity: (raw: unknown) => Severity,
 *   defaultCategory?: string,
 * }} options
 * @returns {Finding[]}
 * @throws {Error} when stdout is not parseable JSON.
 */
export function parseProviderFindings(rawStdout, options) {
  const { errorPrefix, mapSeverity, defaultCategory } = options;
  const text = (rawStdout ?? '').trim();
  if (text.length === 0) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${errorPrefix}: ${err?.message ?? err}`);
  }

  // Unwrap a single layer of envelope when present.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.findings)) parsed = parsed.findings;
    else if (parsed.result !== undefined) parsed = parsed.result;
    else if (parsed.data !== undefined) parsed = parsed.data;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.findings)) parsed = parsed.findings;
  }

  if (!Array.isArray(parsed)) return [];

  /** @type {Finding[]} */
  const findings = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const title =
      typeof entry.title === 'string' && entry.title.trim().length > 0
        ? entry.title.trim()
        : null;
    const body =
      typeof entry.body === 'string' && entry.body.trim().length > 0
        ? entry.body
        : typeof entry.message === 'string' && entry.message.trim().length > 0
          ? entry.message
          : null;
    if (!title || !body) continue;

    /** @type {Finding} */
    const finding = {
      severity: mapSeverity(entry.severity),
      title,
      body,
    };
    const category =
      typeof entry.category === 'string' && entry.category.length > 0
        ? entry.category
        : defaultCategory;
    if (category !== undefined) {
      finding.category = category;
    }
    if (typeof entry.file === 'string' && entry.file.length > 0) {
      finding.file = entry.file;
    }
    if (Number.isInteger(entry.line) && entry.line > 0) {
      finding.line = entry.line;
    }
    findings.push(finding);
  }
  return findings;
}
