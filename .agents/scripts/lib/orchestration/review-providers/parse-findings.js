/**
 * review-providers/parse-findings.js — the JSON-findings parser shared by the
 * LLM-backed providers. Entries without a title or body are dropped rather
 * than fabricated.
 *
 * @typedef {import('./types.js').Finding}  Finding
 * @typedef {import('./types.js').Severity} Severity
 */

import { isObject } from '../../json-utils.js';
import { buildClaim } from './claim-grounding.js';

/** Prompt rule shared by the LLM providers; the parser reads its two fields. */
export const BUG_CLASS_RULE =
  "Name each problem's bug class as a short kebab-case slug in `class`, " +
  'and report every instance of the same defect in this diff as ONE ' +
  'finding whose `instances` lists each location ({"file","line"}); ' +
  '`file` and `line` name the first instance.';

const CLASS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Unwrap a bare array, `{ findings }`, or either under `result`/`data`.
 * A non-array result is returned for the caller to reject.
 *
 * @param {unknown} parsed
 * @returns {unknown}
 */
export function unwrapEnvelope(parsed) {
  let value = parsed;
  if (isObject(value)) {
    if (Array.isArray(value.findings)) value = value.findings;
    else if (value.result !== undefined) value = value.result;
    else if (value.data !== undefined) value = value.data;
  }
  if (isObject(value)) {
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
  return attachLocation(finding, entry);
}

/** `{ file, line? }` when well-formed, else null. */
function toInstance(raw) {
  if (!isObject(raw) || typeof raw.file !== 'string' || raw.file.length === 0)
    return null;
  return Number.isInteger(raw.line) && raw.line > 0
    ? { file: raw.file, line: raw.line }
    : { file: raw.file };
}

/** `file`/`line` lead the list; malformed and repeated instances drop. */
function buildInstances(finding, raw) {
  const listed = Array.isArray(raw) ? raw.map(toInstance).filter(Boolean) : [];
  if (listed.length === 0) return;
  const lead = finding.file ? [toInstance(finding)] : [];
  const seen = new Set();
  finding.instances = [...lead, ...listed].filter((i) => {
    const key = `${i.file}:${i.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const [first] = finding.instances;
  finding.file = first.file;
  if (first.line) finding.line = first.line;
  else delete finding.line;
}

/** Well-formed `file`, `line`, `class`, `instances` and `claim` only. */
function attachLocation(finding, entry) {
  if (typeof entry.file === 'string' && entry.file.length > 0) {
    finding.file = entry.file;
  }
  if (Number.isInteger(entry.line) && entry.line > 0) {
    finding.line = entry.line;
  }
  const slug = coerceString(entry.class)?.toLowerCase();
  if (slug && CLASS_SLUG.test(slug)) finding.class = slug;
  buildInstances(finding, entry.instances);
  const claim = buildClaim(entry.claim);
  if (claim) finding.claim = claim;
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
