/**
 * lib/findings/route-finding.js — the one dedup/route implementation: finding
 * fingerprints, Issue-body footers, and `routeFinding`. Ports are injected.
 */

import crypto from 'node:crypto';

import { fingerprintSeverity } from './severity.js';

const SEP = '␟'; // unit separator — keeps fingerprint fields unambiguous
const MARKER = 'audit-fingerprints:';
const SEMANTIC_MARKER = 'audit-semantic-keys:';
const LABEL_MARKER = 'audit-labels:';
export const SHA1_RE = /^[0-9a-f]{40}$/;
// No `,` or `>`: keys round-trip through a comma-joined HTML-comment footer.
export const SEMANTIC_KEY_RE = /^[^,>]+$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normaliseField(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().trim();
}

/**
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
 * Any change to this folding moves existing shas and breaks dedup against
 * filed Issues.
 *
 * @param {object} finding
 * @returns {{ title: string, area: string, primaryFile: string, severity: string, labels: string }}
 */
function fingerprintComponents(finding) {
  return {
    title: normaliseField(finding?.title),
    area: normaliseField(finding?.area),
    primaryFile: normaliseField(finding?.primaryFile),
    severity: fingerprintSeverity(finding?.severity),
    labels: normaliseLabels(finding?.labels),
  };
}

/**
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
 * Location key (`area` + `primaryFile`), stable across rewording. Empty when
 * the location is unknown; an empty key never confirms a match.
 *
 * @param {object} finding
 * @returns {string}
 */
export function semanticKeyFor(finding) {
  const area = normaliseField(finding?.area);
  const primaryFile = normaliseField(finding?.primaryFile);
  if (!area && !primaryFile) return '';
  const key = `${area}${SEP}${primaryFile}`;
  return SEMANTIC_KEY_RE.test(key) ? key : key.replace(/[,>]/g, ' ').trim();
}

/**
 * @param {string | string[]} keys
 * @returns {string}
 */
export function semanticKeyFooter(keys) {
  const list = (Array.isArray(keys) ? keys : [keys])
    .filter((k) => typeof k === 'string' && k.length > 0)
    .map((k) => k.replace(/[,>]/g, ' ').trim())
    .filter((k) => k.length > 0);
  return `<!-- ${SEMANTIC_MARKER} ${list.join(',')} -->`;
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function parseSemanticKeyFooter(body) {
  return parseAllFooterValues(
    body,
    /<!--\s*audit-semantic-keys:\s*([^>]*?)\s*-->/g,
    (s) => s.length > 0,
  );
}

/**
 * The dedup corpus is listed by `audit::*` label; this footer lets planning
 * stamp them so the Story stays visible to indexed dedup.
 *
 * @param {string | string[]} labels
 * @returns {string}
 */
export function auditLabelFooter(labels) {
  const list = (Array.isArray(labels) ? labels : [labels])
    .filter((l) => typeof l === 'string' && l.startsWith('audit::'))
    .map((l) => l.replace(/[,>]/g, ' ').trim())
    .filter((l) => l.length > 0);
  if (list.length === 0) return '';
  return `<!-- ${LABEL_MARKER} ${[...new Set(list)].sort().join(',')} -->`;
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function parseAuditLabelFooter(body) {
  return parseAllFooterValues(
    body,
    /<!--\s*audit-labels:\s*([^>]*?)\s*-->/g,
    (s) => s.startsWith('audit::'),
  );
}

/**
 * @param {string | string[]} shas
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
 * @param {string} body
 * @returns {string[]}
 */
export function parseFingerprintFooter(body) {
  return parseAllFooterValues(
    body,
    /<!--\s*audit-fingerprints:\s*([^>]+?)\s*-->/g,
    (s) => SHA1_RE.test(s),
  );
}

/**
 * Values from every occurrence of a footer (a multi-group seed carries
 * several), de-duplicated.
 *
 * @param {unknown} text
 * @param {RegExp} pattern — global; capture group 1 is the value list.
 * @param {(value: string) => boolean} isValid
 * @returns {string[]}
 */
function parseAllFooterValues(text, pattern, isValid) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const value = raw.trim();
      if (!isValid(value) || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Append the seed's provenance footers missing from `into`, so the next
 * sweep recognises the Story. Additive and idempotent.
 *
 * @param {{ from?: string, into?: string }} args
 * @returns {{ body: string, carried: boolean, fingerprints: string[], semanticKeys: string[] }}
 *   The arrays hold only newly carried values.
 */
export function carryProvenanceFooters({ from = '', into = '' } = {}) {
  const body = typeof into === 'string' ? into : '';
  const source = typeof from === 'string' ? from : '';

  const have = new Set(parseFingerprintFooter(body));
  const haveKeys = new Set(parseSemanticKeyFooter(body));
  const fingerprints = parseFingerprintFooter(source).filter(
    (sha) => !have.has(sha),
  );
  const semanticKeys = parseSemanticKeyFooter(source).filter(
    (key) => !haveKeys.has(key),
  );

  if (fingerprints.length === 0 && semanticKeys.length === 0) {
    return { body, carried: false, fingerprints: [], semanticKeys: [] };
  }

  const appended = [];
  if (fingerprints.length > 0) appended.push(fingerprintFooter(fingerprints));
  if (semanticKeys.length > 0) appended.push(semanticKeyFooter(semanticKeys));

  const separator = body.length === 0 || body.endsWith('\n') ? '' : '\n';
  return {
    body: `${body}${separator}\n${appended.join('\n')}\n`,
    carried: true,
    fingerprints,
    semanticKeys,
  };
}

/**
 * Rejects a hit that mentions the sha only in prose; a body-less issue is
 * trusted.
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
 * Strict on a missing body: a location match needs a footer to compare.
 *
 * @param {{ body?: string }} issue
 * @param {string} key
 * @returns {boolean}
 */
function issueCarriesSemanticKey(issue, key) {
  if (!key || typeof issue?.body !== 'string') return false;
  return parseSemanticKeyFooter(issue.body).includes(key);
}

/**
 * @param {{ state?: string }} issue
 * @returns {'update-existing'|'regression-of-closed'}
 */
function decisionForIssue(issue) {
  const state = normaliseField(issue?.state);
  return state === 'closed' ? 'regression-of-closed' : 'update-existing';
}

/**
 * Fingerprint owners win outright over location-only neighbours. Sorted so a
 * tie resolves to the earliest-filed issue, not search order.
 *
 * @param {Array<{ number: number, state: string, body?: string }>} confirmed
 * @param {string} sha
 * @returns {Array<{ number: number, state: string }>}
 */
function attributedPool(confirmed, sha) {
  const owns = (issue) => issueCarriesFingerprint(issue, sha);
  const owners = confirmed.filter(owns);
  const pool = owners.length > 0 ? owners : confirmed.filter((i) => !owns(i));
  return [...pool].sort((a, b) => (a?.number ?? 0) - (b?.number ?? 0));
}

/**
 * State is read off the attributed issue, so an open neighbour cannot mask a
 * regression of the closed owner.
 *
 * @param {Array<{ number: number, state: string }>} confirmed
 * @param {string} sha
 * @returns {{ decision: 'new'|'update-existing'|'duplicate'|'regression-of-closed', matchedIssue: object|null, fingerprint: string }}
 */
function decideFromConfirmed(confirmed, sha) {
  if (confirmed.length === 0) {
    return { decision: 'new', matchedIssue: null, fingerprint: sha };
  }

  const attributed = attributedPool(confirmed, sha);
  const open = attributed.filter((h) => normaliseField(h.state) === 'open');
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

  const closed = attributed[0];
  return {
    decision: decisionForIssue(closed),
    matchedIssue: closed,
    fingerprint: sha,
  };
}

/**
 * Only a deterministic footer (fingerprint, or semantic key when supplied)
 * confirms identity.
 *
 * @param {Array<unknown>} hits
 * @param {{ sha: string, semanticKey?: string }} identity
 * @returns {Array<{ number: number, state: string }>}
 */
function confirmCandidates(hits, { sha, semanticKey = '' }) {
  if (!Array.isArray(hits)) return [];
  return hits.filter(
    (h) =>
      h &&
      typeof h.number === 'number' &&
      typeof h.state === 'string' &&
      (issueCarriesFingerprint(h, sha) ||
        issueCarriesSemanticKey(h, semanticKey)),
  );
}

/**
 * First-seen wins, so the fingerprint pool's record survives a tie.
 *
 * @param {Array<unknown>} pools
 * @returns {Array<object>}
 */
function unionCandidatePools(pools) {
  const seen = new Set();
  return pools.flat().filter((issue) => {
    const number = issue?.number;
    if (typeof number !== 'number') return true;
    const fresh = !seen.has(number);
    seen.add(number);
    return fresh;
  });
}

/**
 * A single port's result is returned verbatim; a rejection propagates.
 *
 * @param {object} finding
 * @param {string} sha
 * @param {{ searchIssues?: Function, searchCandidates?: Function }} ports
 * @returns {Promise<Array<object>|unknown>}
 */
async function gatherCandidates(finding, sha, ports) {
  const call = (port, arg) => (typeof port === 'function' ? [port(arg)] : []);
  const pools = await Promise.all([
    ...call(ports.searchIssues, sha),
    ...call(ports.searchCandidates, finding),
  ]);
  return pools.length === 1 ? pools[0] : unionCandidatePools(pools);
}

/**
 * Route a finding against existing Issues. Every wired port runs and pools
 * union: the semantic search must widen, never replace, the exact sha lookup
 * (a bag-of-words query alone re-files duplicates). A rejecting port
 * propagates — a partial pool is unknown, not a confident `new`.
 *
 * @param {object} finding
 * @param {object} ports
 * @param {(sha: string) => Promise<Array<{ number: number, state: string, body?: string }>>} [ports.searchIssues]
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.searchCandidates]
 * @param {object} [options]
 * @param {boolean} [options.semanticKeyConfirm=false] — opt-in; qa-explore
 *   stamps no semantic keys.
 * @returns {Promise<{ decision: 'new'|'update-existing'|'duplicate'|'regression-of-closed', matchedIssue: object|null, fingerprint: string }>}
 */
export async function routeFinding(
  finding,
  { searchIssues, searchCandidates } = {},
  options = {},
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
  const semanticKey = options.semanticKeyConfirm ? semanticKeyFor(finding) : '';

  const hits = await gatherCandidates(finding, sha, {
    searchIssues,
    searchCandidates,
  });

  const confirmed = confirmCandidates(hits, { sha, semanticKey });

  return decideFromConfirmed(confirmed, sha);
}

export const __testing = {
  MARKER,
  gatherCandidates,
  unionCandidatePools,
  SEMANTIC_MARKER,
  SEP,
  confirmCandidates,
  decideFromConfirmed,
  issueCarriesSemanticKey,
  parseSemanticKeyFooter,
  attributedPool,
};
