/**
 * lib/findings/audit-finding-record.js — the seed-only `audit-finding` record:
 * one finding's exact sha → files → label identity, so plan-persist can
 * attribute it to the Stories whose `changes[]` cover its files. Sits beside
 * the footer helpers in `route-finding.js`, whose `extractProvenanceFooters`
 * carries these records through a truncated seed.
 *
 * @module lib/findings/audit-finding-record
 */

import { SHA1_RE } from './route-finding.js';

const RECORD_MARKER = 'audit-finding:';

/**
 * Render one record. Every value is URI-encoded: no path can inject the `,`, space or `>` the record
 * is delimited by. Never stamped on a Story body.
 *
 * @param {{ sha: string, key?: string, label?: string|null, files?: string[] }} record
 * @returns {string}
 */
export function auditFindingRecord({
  sha,
  key = '',
  label = null,
  files = [],
}) {
  if (typeof sha !== 'string' || !SHA1_RE.test(sha)) {
    throw new Error(
      'auditFindingRecord: sha must be a 40-char sha1 hex string',
    );
  }
  const enc = encodeURIComponent;
  const parts = [`sha=${sha}`, `key=${enc(key ?? '')}`];
  if (typeof label === 'string' && label.length > 0) {
    parts.push(`label=${enc(label)}`);
  }
  parts.push(`files=${(files ?? []).map(enc).join(',')}`);
  return `<!-- ${RECORD_MARKER} ${parts.join(' ')} -->`;
}

/**
 * @param {string} raw
 * @returns {string|null} null when the value is not valid URI encoding.
 */
function decodeRecordValue(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} inner — the record's `k=v k=v` payload.
 * @returns {{ sha: string, key: string, label: string|null, files: string[] }|null}
 */
function parseRecordPayload(inner) {
  const fields = new Map();
  for (const token of inner.trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const sha = fields.get('sha') ?? '';
  if (!SHA1_RE.test(sha)) return null;
  const files = (fields.get('files') ?? '')
    .split(',')
    .filter((f) => f.length > 0)
    .map(decodeRecordValue);
  const key = decodeRecordValue(fields.get('key') ?? '');
  const label = fields.has('label')
    ? decodeRecordValue(fields.get('label'))
    : '';
  if (key === null || label === null || files.includes(null)) return null;
  return { sha, key, label: label || null, files };
}

/**
 * Every well-formed `audit-finding` record in `text`, first-seen per sha.
 *
 * @param {unknown} text
 * @returns {Array<{ sha: string, key: string, label: string|null, files: string[] }>}
 */
export function parseAuditFindingRecords(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(/<!--\s*audit-finding:([^>]*?)-->/g)) {
    const record = parseRecordPayload(match[1]);
    if (!record || seen.has(record.sha)) continue;
    seen.add(record.sha);
    out.push(record);
  }
  return out;
}
