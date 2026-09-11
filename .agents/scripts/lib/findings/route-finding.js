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
 *      duplicate | regression-of-closed`. Routing gathers a candidate pool,
 *      then confirms identity against it. **Every wired port runs, and their
 *      results union** (Story #5079): the exact `searchIssues(sha)` lookup is
 *      what reliably retrieves an Issue by its footer sha, while the
 *      meaning-first `searchCandidates` pass (wired to
 *      `semantic-issue-search.js`) widens that pool to catch a reworded
 *      finding whose sha has drifted. The semantic pass **adds** to the
 *      fingerprint lookup; it never replaces it. Whichever ports are wired
 *      query BOTH open and closed issues; a closed fingerprint match yields
 *      `regression-of-closed`.
 *
 * Pure orchestration: no network I/O lives here. The `searchIssues` /
 * `searchCandidates` ports are injected by the caller (production wires them
 * to the GitHub provider; tests pass an in-memory stub).
 */

import crypto from 'node:crypto';

import { fingerprintSeverity } from './severity.js';

const SEP = '␟'; // unit separator — keeps fingerprint fields unambiguous
const MARKER = 'audit-fingerprints:';
const SEMANTIC_MARKER = 'audit-semantic-keys:';
const LABEL_MARKER = 'audit-labels:';
export const SHA1_RE = /^[0-9a-f]{40}$/;
// A semantic key round-trips through a comma-joined footer, so it must not
// carry a comma or a `>` (which would truncate the HTML comment). Both are
// stripped when the key is built, so this guard is defence-in-depth.
export const SEMANTIC_KEY_RE = /^[^,>]+$/;

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
 *
 * **Severity is projected, not raw (Story #4877).** The severity vocabulary was
 * normalised onto the canonical five-level scale in the same change that wrote
 * this comment, and severity is an identity field — so a naive
 * `normaliseField(finding.severity)` here would have re-minted the fingerprint
 * of every finding whose spelling the normalisation touched, silently breaking
 * dedup against every Issue already filed. {@link fingerprintSeverity} is the
 * projection that makes the hash **invariant** under that normalisation: it
 * resolves aliases onto their canonical level, keeps an absent severity as the
 * empty string (what the raw call produced), and passes an unrecognised value
 * through verbatim. Labels are deliberately left on the raw
 * lower-case/trim/sort path for the same reason — order- and case-insensitive
 * already, and any further folding would move existing shas.
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
 * Compute the **location-based semantic key** for a finding. Unlike the
 * fingerprint (which folds in the title, so any prose rewording mints a fresh
 * sha), the semantic key is stable across a reworded title and a re-severitied
 * finding: it is derived solely from the finding's identity *location* —
 * `area` (the audit dimension) plus `primaryFile`. Two scans that describe the
 * same problem at the same location produce the same semantic key even when
 * their titles diverge, so a reworded finding still confirms against the Issue
 * that already tracks that location.
 *
 * Returns the empty string when the location is unknown (no `area` and no
 * `primaryFile`) — an empty key never confirms a match, exactly as an absent
 * fingerprint footer never does.
 *
 * @param {object} finding — canonical finding ({ area, primaryFile, ... }).
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
 * Render the machine-readable semantic-key footer for one or more keys
 * (`<!-- audit-semantic-keys: key,key,... -->`). Stamped alongside the
 * fingerprint footer by the audit filers so a later reworded finding can
 * confirm identity by location when its fingerprint has drifted. Round-trips
 * through {@link parseSemanticKeyFooter}. Empty keys are dropped.
 *
 * @param {string | string[]} keys — one semantic key or an array of them.
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
 * Extract semantic keys from an Issue body carrying the semantic-key footer.
 * The audit filers stamp the footer via {@link semanticKeyFooter}; the
 * confirmation path here, {@link carryProvenanceFooters} and the audit dedup's
 * local issue index read it back. Exported alongside its writer so an indexer
 * cannot drift into a second parse of the same footer.
 *
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
 * Render the machine-readable audit-label footer
 * (`<!-- audit-labels: audit::x,audit::y -->`).
 *
 * The dedup corpus is listed by `audit::*` label, so a Story carrying none is
 * absent from the pool an indexed run matches against — and with an index in
 * play the exact lookup is answered locally and never reaches the provider, so
 * a fingerprint footer alone cannot rescue it. Carrying the labels through the
 * seed is what lets the planning path stamp them without the authoring agent
 * being asked to notice them (Story #5307).
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
 * Read every `audit-labels` footer out of a body, de-duplicated.
 *
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
  return parseAllFooterValues(
    body,
    /<!--\s*audit-fingerprints:\s*([^>]+?)\s*-->/g,
    (s) => SHA1_RE.test(s),
  );
}

/**
 * Collect the comma-separated values out of **every** occurrence of a footer
 * marker in `text`, de-duplicated, in first-seen order.
 *
 * Scanning every occurrence rather than only the first matters for the
 * provenance carry (Story #4877): the audit Single-plan seed stamps one footer
 * pair per MVP Scope bullet, so a multi-group seed carries several. A
 * first-match-only parse silently dropped every group but the first, which
 * would have made the carry look wired while leaking most of the provenance.
 * Reading all footers is also strictly more correct for issue-body confirmation
 * — a body that accumulated two footer lines confirms against either.
 *
 * @param {unknown} text
 * @param {RegExp} pattern — a global regex whose first capture group is the
 *   comma-separated value list.
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
 * Carry audit dedup provenance from a source document into a target body
 * (Story #4877).
 *
 * The audit sweep's Single-plan path emits a `/mandrel-plan` seed whose MVP Scope
 * bullets already carry the `audit-fingerprints` / `audit-semantic-keys`
 * footers (Story #4626). Nothing then copied them into the Story `/mandrel-plan`
 * actually persisted, so the recommended path filed Stories that the next
 * sweep could not recognise and re-filed as new. It was left to the authoring
 * agent to notice HTML comments in a one-pager and hand-carry them — a
 * remembered step, which is to say no step at all.
 *
 * This is that carry, as a function: harvest both footers out of `from`, and
 * append whichever provenance `into` is missing. It is deliberately:
 *
 * - **Additive.** Shas and keys already present in `into` are never duplicated,
 *   and a footer `into` already carries is left exactly as authored.
 * - **Union-preserving.** When both sides carry footers the result carries the
 *   union, so a hand-authored fingerprint is not dropped in favour of the seed's.
 * - **Idempotent.** Re-running over its own output is a no-op, so a resumed
 *   persist cannot stack footers.
 * - **Silent on nothing-to-do.** No provenance in `from` returns `into`
 *   unchanged with `carried: false`, so a non-audit plan run is untouched.
 *
 * @param {{ from?: string, into?: string }} args — `from` is the provenance
 *   source (the seed markdown); `into` is the body being persisted.
 * @returns {{ body: string, carried: boolean, fingerprints: string[], semanticKeys: string[] }}
 *   `body` is the augmented text; `fingerprints` / `semanticKeys` are the values
 *   newly carried (empty when there was nothing to carry).
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
 * Confirm an issue body's footer carries the target semantic key. Unlike
 * {@link issueCarriesFingerprint}, this is strict on a missing body — a
 * location match is only meaningful when the issue actually carries a
 * semantic-key footer to compare against.
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
 * Decide the route decision from a confirmed matched issue's state.
 * @param {{ state?: string }} issue
 * @returns {'update-existing'|'regression-of-closed'}
 */
function decisionForIssue(issue) {
  const state = normaliseField(issue?.state);
  return state === 'closed' ? 'regression-of-closed' : 'update-existing';
}

/**
 * Resolve the pool that **attributes** a finding, out of everything that
 * confirmed it (Story #5045).
 *
 * Confirmation admits two different strengths of claim, and collapsing them
 * was the source of two wrong routes:
 *
 * - An issue carrying the finding's exact **fingerprint** owns it. That is
 *   identity: this issue tracks *this* finding.
 * - An issue matching only on the location-based **semantic key** is merely
 *   adjacent: it tracks *a* finding at the same `area␟primaryFile`.
 *
 * Owners win outright when any exist. Location-only matches are not discarded
 * — they are the whole point of the semantic key and remain the pool when
 * nothing carries the fingerprint (a reworded finding at an unchanged
 * location). The pool is sorted by issue number so a genuine tie resolves to
 * the earliest-filed issue rather than to whatever order the search port
 * happened to return.
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
 * Decide the final route from a confirmed-match pool (issues that both
 * surfaced in the candidate/search pass AND carry a confirming footer).
 * Shared by both the semantic-first and fingerprint-only code paths so the
 * decision enum is identical regardless of how candidates were gathered.
 *
 * **Attribution decides, not array order (Story #5045).** The pool used to be
 * read flat, which produced two wrong answers whenever more than one issue
 * confirmed:
 *
 *   1. Two open matches routed `duplicate` pinned to `open[0]` — whichever
 *    issue the search port happened to return first. With per-Story
 *    provenance that pick is answerable rather than arbitrary: the issue
 *    carrying the finding's own fingerprint owns it, and a sibling matching
 *    only by location does not.
 *   2. Any open match at all masked a closed one, so a finding whose
 *    fingerprint is owned by a **closed** Story routed `update-existing`
 *    against an open neighbour — a genuine regression filed as a
 *    business-as-usual update. Attribution restores it: state is read off the
 *    owning issue, not off whatever else shares its location.
 *
 * {@link attributedPool} owns that selection; the decision below reads only
 * the pool it returns.
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
 * Keep only the issue records that have the right wire shape AND carry a
 * confirming footer. Confirmation is by the exact **fingerprint** footer and,
 * when a `semanticKey` is supplied (audit dedup opts in via
 * `options.semanticKeyConfirm`), ALSO by the location-based **semantic-key**
 * footer. A semantic candidate that merely *looks* similar but carries neither
 * footer is dropped here — semantic similarity widens the net; a deterministic
 * footer (fingerprint or semantic key) is what confirms identity. The semantic
 * key catches a reworded finding whose fingerprint has drifted but whose
 * location is unchanged.
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
 * Union candidate pools into one flat pool, keeping first-seen order and
 * dropping an issue number an earlier pool already contributed.
 *
 * The fingerprint pool is passed first, so when both ports return the same
 * Issue it is that pool's record — the one retrieved by exact identity — that
 * survives into confirmation. Records without a usable number are left for
 * {@link confirmCandidates} to reject, exactly as a single port's would be.
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
 * Gather the candidate pool for a finding from every wired port.
 *
 * A run with a single wired port returns that port's result **verbatim**, so
 * the fingerprint-only wiring (`qa-explore`, and every caller that injects no
 * semantic port) keeps its behaviour exactly — including how a non-array
 * return is handled downstream by {@link confirmCandidates}.
 *
 * Both ports are awaited together; a rejection from either propagates rather
 * than degrading silently to a partial pool.
 *
 * @param {object} finding
 * @param {string} sha — the finding's full fingerprint.
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
 * Route a finding against existing Issues: gather candidates, then confirm.
 *
 * **Gather — every wired port runs, and their pools union (Story #5079).** The
 * two ports answer different questions and neither subsumes the other:
 *
 * - `searchIssues(sha)` is the **exact** lookup. A fingerprint sha is one
 *   high-signal term, so it retrieves the Issue whose footer carries it.
 * - `searchCandidates(finding)` is the **meaning-first** pass. It widens the
 *   pool to Issues describing the same problem under a different title, so a
 *   reworded finding or a moved file still confirms by semantic key.
 *
 * This was a ternary until Story #5079: an injected semantic port *replaced*
 * the fingerprint lookup instead of widening it. Production always injects
 * one, so `searchIssues` was dead code on the live path and dedup rested
 * entirely on a ~20-token bag-of-words query that does not reliably retrieve
 * the Issue. The audit loop consequently re-filed Stories it had already
 * filed, against the workflow's "Never open a duplicate Issue" constraint.
 * Running both ports and unioning their pools is what closes that loop.
 *
 * A port that rejects **propagates**. A pool gathered from only some of its
 * sources is not a smaller pool, it is an unknown one, so the caller
 * (`classifyGroupsAgainstGitHub`) must record a degraded lookup rather than
 * report a confident `new`.
 *
 * **Confirm.** The pooled candidates are filtered down to those that actually
 * carry the finding's fingerprint footer — or, when `semanticKeyConfirm` is
 * on, its location-based semantic-key footer — then resolved:
 *   - An open match → `update-existing` (or `duplicate` when more than one
 *     open issue carries the fingerprint).
 *   - A closed match (no open match) → `regression-of-closed`.
 *   - No confirmed match → `new`.
 *
 * The decision enum is identical however the candidates were gathered.
 *
 * @param {object} finding
 * @param {object} ports
 * @param {(sha: string) => Promise<Array<{ number: number, state: string, body?: string }>>} [ports.searchIssues]
 *   Fingerprint-keyed lookup over open+closed issues. Runs whenever it is
 *   supplied. Required when `searchCandidates` is not.
 * @param {(finding: object) => Promise<Array<{ number: number, state: string, title?: string, body?: string }>>} [ports.searchCandidates]
 *   Meaning-first candidate search over open+closed issues (and Epic
 *   sub-issues). Runs whenever it is supplied, alongside `searchIssues` rather
 *   than instead of it; the union is then confirmed by footer.
 * @param {object} [options]
 * @param {boolean} [options.semanticKeyConfirm=false] — also confirm a
 *   candidate by the location-based semantic-key footer, not the fingerprint
 *   alone. Opt-in so the audit dedup path catches a reworded finding at an
 *   unchanged location while the qa-explore path (which does not stamp
 *   semantic-key footers) stays fingerprint-exact and byte-identical.
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

  // Gather: every wired port runs, and their pools union (Story #5079).
  const hits = await gatherCandidates(finding, sha, {
    searchIssues,
    searchCandidates,
  });

  // Confirm identity by fingerprint footer (and, when opted in, the
  // location-based semantic-key footer) over the pooled candidates.
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
