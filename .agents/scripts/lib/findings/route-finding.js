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
 *   3. `routeFinding(finding, { searchIssues, searchCandidates })` — classify a
 *      finding against existing Issues into one of `new | update-existing |
 *      duplicate | regression-of-closed`. Routing is a two-stage pass: a
 *      meaning-first **semantic candidate** pass runs FIRST (when a
 *      `searchCandidates` port is injected, e.g. wired to
 *      `semantic-issue-search.js`), then the exact **fingerprint
 *      confirmation** pass runs SECOND over that candidate pool. When no
 *      semantic port is injected the helper falls back to a fingerprint-only
 *      lookup via the `searchIssues` port. Either way the ports query BOTH
 *      open and closed issues; a closed fingerprint match yields
 *      `regression-of-closed`.
 *
 * Pure orchestration: no network I/O lives here. The `searchIssues` /
 * `searchCandidates` ports are injected by the caller (production wires them
 * to the GitHub provider; tests pass an in-memory stub).
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
 * Decide the final route from a confirmed-match pool (issues that both
 * surfaced in the candidate/search pass AND carry the finding's fingerprint
 * in their footer). Shared by both the semantic-first and fingerprint-only
 * code paths so the decision enum is identical regardless of how candidates
 * were gathered.
 *
 * @param {Array<{ number: number, state: string }>} confirmed
 * @param {string} sha
 * @returns {{ decision: 'new'|'update-existing'|'duplicate'|'regression-of-closed', matchedIssue: object|null, fingerprint: string }}
 */
function decideFromConfirmed(confirmed, sha) {
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

/**
 * Keep only the issue records that have the right wire shape AND carry the
 * target fingerprint in their footer. A semantic candidate that merely *looks*
 * similar but does not carry the sha is dropped here — semantic similarity
 * widens the net; the fingerprint footer is what confirms identity.
 *
 * @param {Array<unknown>} hits
 * @param {string} sha
 * @returns {Array<{ number: number, state: string }>}
 */
function confirmFingerprint(hits, sha) {
  if (!Array.isArray(hits)) return [];
  return hits.filter(
    (h) =>
      h &&
      typeof h.number === 'number' &&
      typeof h.state === 'string' &&
      issueCarriesFingerprint(h, sha),
  );
}

/**
 * Route a finding against existing Issues with a two-stage pass.
 *
 * **Stage 1 — semantic candidate search (first).** When a `searchCandidates`
 * port is injected, it runs first to surface issues that *describe the same
 * problem by meaning* across BOTH open and closed issues (and, when the
 * caller wires it, an Epic's sub-issues). This widens the net beyond an exact
 * fingerprint so a reworded title or a moved file does not hide a real
 * duplicate. When no `searchCandidates` port is supplied the helper skips
 * straight to Stage 2 over the `searchIssues` lookup — the legacy
 * fingerprint-only behaviour, preserved verbatim.
 *
 * **Stage 2 — fingerprint confirmation (second).** Whatever candidates Stage 1
 * produced are filtered down to those that actually carry the finding's
 * fingerprint footer, then resolved:
 *   - An open match → `update-existing` (or `duplicate` when more than one
 *     open issue carries the fingerprint).
 *   - A closed match (no open match) → `regression-of-closed`.
 *   - No confirmed match → `new`.
 *
 * The decision enum is identical on both paths.
 *
 * @param {object} finding
 * @param {object} ports
 * @param {(sha: string) => Promise<Array<{ number: number, state: string, body?: string }>>} [ports.searchIssues]
 *   Fingerprint-keyed lookup over open+closed issues. Required when
 *   `searchCandidates` is not supplied.
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.searchCandidates]
 *   Meaning-first candidate search over open+closed issues (and Epic
 *   sub-issues). When supplied, runs FIRST; its candidates are then
 *   fingerprint-confirmed.
 * @returns {Promise<{ decision: 'new'|'update-existing'|'duplicate'|'regression-of-closed', matchedIssue: object|null, fingerprint: string }>}
 */
export async function routeFinding(
  finding,
  { searchIssues, searchCandidates } = {},
) {
  if (
    typeof searchCandidates !== 'function' &&
    typeof searchIssues !== 'function'
  ) {
    throw new Error(
      'routeFinding: a searchCandidates or searchIssues port is required',
    );
  }

  const { full: sha } = fingerprintFinding(finding);

  // Stage 1: semantic candidate pass first (when wired); else fingerprint
  // lookup. Both yield a candidate pool drawn from open AND closed issues.
  const hits =
    typeof searchCandidates === 'function'
      ? await searchCandidates(finding)
      : await searchIssues(sha);

  // Stage 2: confirm identity by fingerprint footer over the candidate pool.
  const confirmed = confirmFingerprint(hits, sha);

  return decideFromConfirmed(confirmed, sha);
}

export const __testing = {
  MARKER,
  SEP,
  confirmFingerprint,
  decideFromConfirmed,
};
