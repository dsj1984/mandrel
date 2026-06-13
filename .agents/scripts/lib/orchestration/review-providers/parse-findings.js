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
 * Story #4074 — the parser body was a CC-30 ternary thicket. The
 * per-field branching now lives in three small, independently-testable
 * pure helpers (`unwrapEnvelope`, `coerceString`, `buildFinding`), so the
 * orchestration body collapses to: unwrap → `Array.isArray` guard →
 * `map(buildFinding).filter(Boolean)`.
 *
 * @typedef {import('./types.js').Finding}  Finding
 * @typedef {import('./types.js').Severity} Severity
 */

/**
 * Unwrap up to two layers of envelope around a findings array.
 *
 * Accepts a bare array unchanged, an object with a `findings` array, or
 * either shape nested one level deep under a `result` / `data` key. The
 * second pass resolves `{ result: { findings: [] } }`-style
 * double-envelopes. Anything that does not resolve to an array is
 * returned as-is for the caller's `Array.isArray` guard to reject.
 *
 * @param {unknown} parsed
 * @returns {unknown}
 */
export function unwrapEnvelope(parsed) {
  let value = parsed;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.findings)) value = value.findings;
    else if (value.result !== undefined) value = value.result;
    else if (value.data !== undefined) value = value.data;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(value.findings)) value = value.findings;
  }
  return value;
}

/**
 * Coerce a value to a non-empty trimmed string, or null.
 *
 * Returns the trimmed string when `value` is a string with
 * non-whitespace content; otherwise null.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a single `Finding` from a raw entry, or null when the entry is
 * unusable (not an object, or missing a title/body).
 *
 * `title` is trimmed; `body` falls back to a non-empty `message` alias
 * and is preserved verbatim (untrimmed) to match the historical
 * behavior. `category` is set from the entry when present, else from
 * `defaultCategory` when supplied. `file` / `line` are included only
 * when present and well-formed.
 *
 * @param {unknown} entry
 * @param {{
 *   mapSeverity: (raw: unknown) => Severity,
 *   defaultCategory?: string,
 * }} options
 * @returns {Finding | null}
 */
export function buildFinding(entry, { mapSeverity, defaultCategory }) {
  if (!entry || typeof entry !== 'object') return null;

  const title = coerceString(entry.title);
  const body = coerceString(entry.body)
    ? entry.body
    : coerceString(entry.message)
      ? entry.message
      : null;
  if (!title || !body) return null;

  /** @type {Finding} */
  const finding = { severity: mapSeverity(entry.severity), title, body };

  const category =
    typeof entry.category === 'string' && entry.category.length > 0
      ? entry.category
      : defaultCategory;
  if (category !== undefined) finding.category = category;

  if (typeof entry.file === 'string' && entry.file.length > 0) {
    finding.file = entry.file;
  }
  if (Number.isInteger(entry.line) && entry.line > 0) {
    finding.line = entry.line;
  }
  return finding;
}

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

  const unwrapped = unwrapEnvelope(parsed);
  if (!Array.isArray(unwrapped)) return [];

  return unwrapped
    .map((entry) => buildFinding(entry, { mapSeverity, defaultCategory }))
    .filter(Boolean);
}
