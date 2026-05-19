/**
 * lib/audit-to-stories/fingerprint.js — Stable per-finding fingerprint.
 *
 * The fingerprint keys a finding for idempotency: two parser runs against
 * the same audit report MUST produce the same fingerprint, and a finding
 * that drifts only in unrelated prose MUST still match its prior key.
 *
 * The fingerprint inputs are deliberately narrow:
 *   1. `dimension` — lower-cased (parser already normalises).
 *   2. `normalisedTitle` — punctuation-stripped, lower-cased finding title.
 *   3. `primaryFile`    — the first path string the parser pulled from the
 *                         finding body, or the empty string when none.
 *
 * The fingerprint is `sha1(dim|title|file)` truncated to 12 hex chars. The
 * full sha1 is exposed too — callers stamping the marker into Issue bodies
 * use the full key to minimise collision risk across thousands of issues
 * in a long-running repo; the short form is for human-facing logs.
 */

import crypto from 'node:crypto';

const SEP = '␟'; // unit separator — keeps fields unambiguous

function pickPrimaryFile(finding) {
  if (!finding) return '';
  if (Array.isArray(finding.files) && finding.files.length > 0) {
    return finding.files[0];
  }
  return '';
}

/**
 * @param {{ dimension?: string, normalisedTitle?: string, files?: string[] }} finding
 * @returns {{ short: string, full: string, components: { dimension: string, normalisedTitle: string, primaryFile: string } }}
 */
export function fingerprintFinding(finding) {
  const dimension = (finding?.dimension ?? '').toLowerCase().trim();
  const normalisedTitle = (finding?.normalisedTitle ?? '').toLowerCase().trim();
  const primaryFile = pickPrimaryFile(finding);
  const components = { dimension, normalisedTitle, primaryFile };

  const payload = `${dimension}${SEP}${normalisedTitle}${SEP}${primaryFile}`;
  const full = crypto.createHash('sha1').update(payload).digest('hex');
  return { short: full.slice(0, 12), full, components };
}

/**
 * Stamp every finding with its fingerprint and return a new array.
 *
 * @template T
 * @param {Array<T>} findings
 * @returns {Array<T & { fingerprint: { short: string, full: string } }>}
 */
export function withFingerprints(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('withFingerprints: findings must be an array');
  }
  return findings.map((f) => ({ ...f, fingerprint: fingerprintFinding(f) }));
}

const MARKER = 'audit-fingerprints:';

/**
 * Render the machine-readable fingerprint footer for an Issue body.
 *
 * @param {Array<{ fingerprint: { full: string } }>} findings
 * @returns {string}
 */
export function renderFingerprintFooter(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('renderFingerprintFooter: findings must be an array');
  }
  const shas = findings
    .map((f) => f?.fingerprint?.full)
    .filter((sha) => typeof sha === 'string' && sha.length > 0);
  return `<!-- ${MARKER} ${shas.join(',')} -->`;
}

/**
 * Extract fingerprint sha1s from an Issue body that carries the footer.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseFingerprintFooter(body) {
  if (typeof body !== 'string') return [];
  const match = body.match(/<!--\s*audit-fingerprints:\s*([^>]+?)\s*-->/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
}

export const __testing = { MARKER, SEP };
