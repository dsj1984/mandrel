/**
 * Project parsed audit findings onto the shared findings identity. No
 * fingerprint or dedup logic of its own — that lives in `route-finding.js`.
 */

import {
  fingerprintFinding,
  fingerprintFooter,
  semanticKeyFooter,
  semanticKeyFor,
} from '../findings/route-finding.js';

/**
 * `dimension` is both `area` and the sole label, so identity stays
 * `(dimension, normalisedTitle, primaryFile)`; severity is excluded.
 *
 * @param {{ dimension?: string, normalisedTitle?: string, files?: string[] }} finding
 * @returns {{ title: string, area: string, primaryFile: string, severity: string, labels: string[] }}
 */
export function toCanonicalFinding(finding) {
  const dimension = finding?.dimension ?? '';
  const primaryFile =
    Array.isArray(finding?.files) && finding.files.length > 0
      ? finding.files[0]
      : '';
  return {
    title: finding?.normalisedTitle ?? '',
    area: dimension,
    primaryFile,
    severity: '',
    labels: dimension ? [dimension] : [],
  };
}

/**
 * @param {object} finding
 * @returns {{ short: string, full: string, components: object }}
 */
export function fingerprintAuditFinding(finding) {
  return fingerprintFinding(toCanonicalFinding(finding));
}

/**
 * Location-based key, stable across a reworded title.
 *
 * @param {object} finding
 * @returns {string}
 */
function semanticKeyForAuditFinding(finding) {
  return semanticKeyFor(toCanonicalFinding(finding));
}

/**
 * @template T
 * @param {Array<T>} findings
 * @returns {Array<T & { fingerprint: { short: string, full: string } }>}
 */
export function withFingerprints(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('withFingerprints: findings must be an array');
  }
  return findings.map((f) => ({
    ...f,
    fingerprint: fingerprintAuditFinding(f),
  }));
}

/**
 * Findings must already carry `fingerprint.full` ({@link withFingerprints}).
 *
 * @param {Array<{ fingerprint?: { full?: string } }>} findings
 * @returns {string}
 */
export function renderFingerprintFooter(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('renderFingerprintFooter: findings must be an array');
  }
  const shas = findings
    .map((f) => f?.fingerprint?.full)
    .filter((sha) => typeof sha === 'string' && sha.length > 0);
  return fingerprintFooter(shas);
}

/**
 * Lets a reworded finding at the same location still confirm a dedup match.
 *
 * @param {Array<object>} findings
 * @returns {string}
 */
export function renderSemanticKeyFooter(findings) {
  if (!Array.isArray(findings)) {
    throw new Error('renderSemanticKeyFooter: findings must be an array');
  }
  const keys = [
    ...new Set(
      findings
        .map((f) => semanticKeyForAuditFinding(f))
        .filter((k) => typeof k === 'string' && k.length > 0),
    ),
  ];
  return semanticKeyFooter(keys);
}
