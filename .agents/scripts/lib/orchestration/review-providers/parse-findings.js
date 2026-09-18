/**
 * review-providers/parse-findings.js — the JSON-findings parser shared by the
 * LLM-backed providers. Entries without a title or body are dropped rather
 * than fabricated.
 *
 * @typedef {import('./types.js').Finding}  Finding
 * @typedef {import('./types.js').Severity} Severity
 */

/**
 * Unwrap a bare array, `{ findings }`, or either under `result`/`data`.
 * A non-array result is returned for the caller to reject.
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
 * @param {unknown} value
 * @returns {string | null}
 */
export function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `body` (or its `message` alias) is kept untrimmed; `category` falls back
 * to `defaultCategory`.
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
