/**
 * lib/findings/route-finding.js — Shared dedup/route helper for findings.
 *
 * This module is the single dedup/route implementation that both
 * `audit-to-stories` and `qa-explore` consume. It does three things:
 *
 *   1. `fingerprintFinding(finding)` — a stable sha1 over the finding's
 *      identity fields (`title`, `area`, `primaryFile`, `severity`,
 *      `labels`). Two runs over the same finding MUST produce the same
 *      sha, and unrelated prose drift MUST NOT change it.
 *   2. `fingerprintFooter(sha)` / `parseFingerprintFooter(body)` — round-trip
 *      the machine-readable `<!-- audit-fingerprints: sha,sha,... -->` marker
 *      stamped into Issue bodies.
 *   3. `routeFinding(finding, { searchIssues })` — classify a finding against
 *      existing Issues into one of `new | update-existing | duplicate |
 *      regression-of-closed`. The `searchIssues` port queries BOTH open and
 *      closed issues; a closed fingerprint match yields `regression-of-closed`.
 *
 * Pure orchestration: no network I/O lives here. The `searchIssues` port is
 * injected by the caller (production wires it to the GitHub provider; tests
 * pass an in-memory stub).
 */

import crypto from 'node:crypto';

const SEP = '␟'; // unit separator — keeps fingerprint fields unambiguous
const MARKER = 'audit-fingerprints:';
const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * Normalise a single scalar identity field to a stable string.
 * @param {unknown} value
 * @returns {string}
 */
function normaliseField(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().trim();
}

/**
 * Normalise the `labels` array into a stable, order-independent string.
 * @param {unknown} labels
 * @returns {string}
 */
function normaliseLabels(labels) {
  if (!Array.isArray(labels)) return '';
  return labels
    .map((l) => normaliseField(l))
    .filter((l) => l.length > 0)
    .sort()
    .join(',');
}

/**
 * Compute the stable identity payload for a finding.
 * @param {object} finding
 * @returns {{ title: string, area: string, primaryFile: string, severity: string, labels: string }}
 */
function fingerprintComponents(finding) {
  return {
    title: normaliseField(finding?.title),
    area: normaliseField(finding?.area),
    primaryFile: normaliseField(finding?.primaryFile),
    severity: normaliseField(finding?.severity),
    labels: normaliseLabels(finding?.labels),
  };
}

/**
 * Stable per-finding fingerprint over {title, area, primaryFile, severity, labels}.
 *
 * @param {object} finding
 * @returns {{ short: string, full: string, components: object }}
 */
export function fingerprintFinding(finding) {
  const components = fingerprintComponents(finding);
  const payload = [
    components.title,
    components.area,
    components.primaryFile,
    components.severity,
    components.labels,
  ].join(SEP);
  const full = crypto.createHash('sha1').update(payload).digest('hex');
  return { short: full.slice(0, 12), full, components };
}

/**
 * Render the machine-readable fingerprint footer for one or more shas.
 *
 * Accepts either a single 40-char sha1 or an array of them, so a footer
 * can carry every finding sha that a grouped Issue tracks
 * (`<!-- audit-fingerprints: sha,sha,... -->`). The comma-joined form
 * round-trips through {@link parseFingerprintFooter}. This is the single
 * footer renderer shared by `audit-to-stories` and `qa-explore`; neither
 * consumer defines its own marker.
 *
 * @param {string | string[]} shas — full 40-char sha1, or an array of them.
 * @returns {string}
 */
export function fingerprintFooter(shas) {
  const list = Array.isArray(shas) ? shas : [shas];
  for (const sha of list) {
    if (typeof sha !== 'string' || !SHA1_RE.test(sha)) {
      throw new Error(
        'fingerprintFooter: every sha must be a 40-char sha1 hex string',
      );
    }
  }
  return `<!-- ${MARKER} ${list.join(',')} -->`;
}

/**
 * Extract fingerprint sha1s from an Issue body carrying the footer marker.
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
    .filter((s) => SHA1_RE.test(s));
}

/**
 * Confirm an issue body's footer actually carries the target sha. Guards
 * against a false-positive search hit (e.g. a body that mentions the sha in
 * prose rather than in the fingerprint footer).
 *
 * @param {{ body?: string }} issue
 * @param {string} sha
 * @returns {boolean}
 */
function issueCarriesFingerprint(issue, sha) {
  if (typeof issue?.body !== 'string') return true;
  return parseFingerprintFooter(issue.body).includes(sha);
}

/**
 * Decide the route decision from a confirmed matched issue's state.
 * @param {{ state?: string }} issue
 * @returns {'update-existing'|'regression-of-closed'}
 */
function decisionForIssue(issue) {
  const state = normaliseField(issue?.state);
  return state === 'closed' ? 'regression-of-closed' : 'update-existing';
}

/**
 * Route a finding against existing Issues.
 *
 * The `searchIssues` port queries BOTH open and closed issues for the
 * finding's fingerprint. Resolution order:
 *   - An open match → `update-existing` (or `duplicate` when more than one
 *     open issue carries the fingerprint).
 *   - A closed match (no open match) → `regression-of-closed`.
 *   - No match → `new`.
 *
 * @param {object} finding
 * @param {{ searchIssues: (sha: string) => Promise<Array<{ number: number, state: string, body?: string }>> }} ports
 * @returns {Promise<{ decision: 'new'|'update-existing'|'duplicate'|'regression-of-closed', matchedIssue: object|null, fingerprint: string }>}
 */
export async function routeFinding(finding, { searchIssues } = {}) {
  if (typeof searchIssues !== 'function') {
    throw new Error('routeFinding: searchIssues port is required');
  }

  const { full: sha } = fingerprintFinding(finding);
  const hits = await searchIssues(sha);
  const confirmed = Array.isArray(hits)
    ? hits.filter(
        (h) =>
          h &&
          typeof h.number === 'number' &&
          typeof h.state === 'string' &&
          issueCarriesFingerprint(h, sha),
      )
    : [];

  if (confirmed.length === 0) {
    return { decision: 'new', matchedIssue: null, fingerprint: sha };
  }

  const open = confirmed.filter((h) => normaliseField(h.state) === 'open');
  if (open.length > 1) {
    return { decision: 'duplicate', matchedIssue: open[0], fingerprint: sha };
  }
  if (open.length === 1) {
    return {
      decision: 'update-existing',
      matchedIssue: open[0],
      fingerprint: sha,
    };
  }

  const closed = confirmed[0];
  return {
    decision: decisionForIssue(closed),
    matchedIssue: closed,
    fingerprint: sha,
  };
}

export const __testing = { MARKER, SEP };
