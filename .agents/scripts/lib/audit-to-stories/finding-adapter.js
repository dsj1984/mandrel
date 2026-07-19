/**
 * lib/audit-to-stories/finding-adapter.js — Project audit findings onto the
 * shared findings identity.
 *
 * `/audit-to-stories` parses `audit-*-results.md` into findings shaped as
 * `{ dimension, severity, title, normalisedTitle, files, ... }`. The shared
 * dedup/route helper (`lib/findings/route-finding.js`) fingerprints over the
 * canonical identity `{ title, area, primaryFile, severity, labels }`. This
 * module is the thin, audit-specific adapter that maps the former onto the
 * latter and reuses the shared helper's primitives — it contains **no**
 * fingerprint or dedup logic of its own. The single dedup/route
 * implementation lives in `lib/findings/route-finding.js`, shared verbatim
 * with `qa-explore`.
 */

import {
  fingerprintFinding,
  fingerprintFooter,
  semanticKeyFooter,
  semanticKeyFor,
} from '../findings/route-finding.js';

/**
 * Map an audit finding onto the canonical identity the shared helper
 * fingerprints over. The audit pipeline already lower-cases `dimension` and
 * normalises the title; `files[0]` is the primary file the parser pulled
 * from the finding body. `dimension` is the identity axis (carried as
 * `area`) and also the sole label so two findings in the same dimension that
 * are otherwise identical collide exactly as the legacy
 * `(dimension, normalisedTitle, primaryFile)` key did.
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
 * Compute the shared-helper fingerprint for a single audit finding.
 *
 * @param {object} finding
 * @returns {{ short: string, full: string, components: object }}
 */
export function fingerprintAuditFinding(finding) {
  return fingerprintFinding(toCanonicalFinding(finding));
}

/**
 * Compute the location-based semantic key for a single audit finding via the
 * shared helper. Stable across a reworded title; used to confirm a dedup
 * match when the fingerprint has drifted (Story #4626).
 *
 * @param {object} finding
 * @returns {string}
 */
export function semanticKeyForAuditFinding(finding) {
  return semanticKeyFor(toCanonicalFinding(finding));
}

/**
 * Stamp every audit finding with its shared-helper fingerprint and return a
 * new array. Mirrors the legacy `withFingerprints` contract so downstream
 * grouping / story-body / dedupe consumers keep reading `finding.fingerprint`.
 *
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
 * Render the machine-readable fingerprint footer for a group of findings,
 * via the shared helper's single footer renderer. Findings must already
 * carry `fingerprint.full` (set by {@link withFingerprints}).
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
 * Render the location-based semantic-key footer for a group of findings, via
 * the shared helper's single footer renderer. Stamped alongside the
 * fingerprint footer so a later reworded finding at the same location still
 * confirms a dedup match (Story #4626). Findings do not need a precomputed
 * key — it is derived from each finding's canonical projection here.
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
