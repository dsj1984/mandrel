/**
 * audit-results-graduator.js — Auto-graduate non-blocking audit findings
 * from the Epic's unified `verification-results` structured comment into
 * routed GitHub follow-up issues. Story #2615 / Epic #2586.
 *
 * Story #4411 (Epic #4405) unified the former `audit-results` and
 * `code-review` structured-comment contracts into one `verification-results`
 * contract: this graduator now reads the shared
 * {@link VERIFICATION_RESULTS_MARKER} comment rather than the retired
 * audit-results structured-comment marker. The lens-aware finding
 * parser, the `audit-results::<severity>` + `domain::<lens>` label shape,
 * and the audit idempotency marker are unchanged.
 *
 * As of Story #3845 / Epic #3823 the spawn helper, the path/idempotency
 * probes, the `gh issue create` filer, the toggle reader, and the
 * route → probe → file walk all live in the shared
 * [`graduator-core.js`](./graduator-core.js). This module is the thin
 * audit-specific shell: it owns the audit finding parser (lens detection
 * plus the 🔵→low / 🟢→suggestion severity mapping), the audit label /
 * title / body shape, and the audit idempotency marker. Behaviour is
 * identical to the pre-consolidation graduator.
 *
 *   - Read the unified `verification-results` structured comment off the
 *     Epic ticket via the injected provider (`getTicketComments`).
 *   - For each non-blocking finding (severity high/medium/low/suggestion
 *     — i.e. anything that is NOT a 🔴 Critical Blocker), check that
 *     the cited file still exists in the merged tree.
 *   - Route by source classification (framework vs consumer) using
 *     `classifyPathSource`. Cross-repo findings are recorded under
 *     `skipped: 'cross-repo-deferred'` and the would-be `gh issue
 *     create` invocation is logged — never shelled out across repos.
 *   - File a follow-up issue with `gh issue create` carrying:
 *       - `meta::audit-finding`
 *       - `meta::framework-gap` or `meta::consumer-improvement`
 *       - `audit-results::<severity>` (high|medium|low|suggestion)
 *       - `domain::<lens-name>` (e.g. `domain::audit-security`)
 *   - Embed an idempotency marker in each body:
 *       <!-- audit-results-followup: epic-<id>-finding-<idx> -->
 *     Before filing, probe via `gh search issues "<marker>"` and skip
 *     findings whose marker is already present.
 *   - Short-circuit when
 *     `config.delivery.feedbackLoop.auditResultsAutoFile` is `false` —
 *     return `{ filed: [], skipped: [{ reason: 'toggle-disabled' }],
 *     errors: [] }`.
 *   - NEVER throw. Every failure path is captured in `errors[]`.
 */

import {
  fingerprintFinding,
  fingerprintFooter,
  semanticKeyFooter,
  semanticKeyFor,
} from '../findings/route-finding.js';
import {
  contentFingerprint,
  graduate,
  makeIsAutoFileEnabled,
  NO_VERIFICATION_RESULTS_COMMENT_REASON,
  VERIFICATION_RESULTS_MARKER,
} from './graduator-core.js';

/**
 * Resolve the toggle from the resolved agentrc config. Defaults to `true`
 * — the feature is opt-out, not opt-in.
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export const isAutoFileEnabled = makeIsAutoFileEnabled('auditResultsAutoFile');

/**
 * Severity → label mapping. Only non-blocking severities have a route;
 * 🔴 Critical Blocker is explicitly filtered out upstream.
 */
const SEVERITY_LABEL = Object.freeze({
  high: 'audit-results::high',
  medium: 'audit-results::medium',
  low: 'audit-results::low',
  suggestion: 'audit-results::suggestion',
});

/**
 * Map a classification source to its meta routing label.
 *
 * @param {string} source
 * @returns {string}
 */
function metaSourceLabel(source) {
  return source === 'framework'
    ? 'meta::framework-gap'
    : 'meta::consumer-improvement';
}

/**
 * Build the **legacy** idempotency marker for a given epicId / finding
 * index. Superseded by the content-hash marker
 * ({@link buildContentMarker}) at the Story #4415 cutover, but still
 * probed for so follow-ups filed before the cutover are recognized and
 * not re-filed. An HTML comment so it survives markdown rendering without
 * leaking into the visible body; the idempotency probe strips the comment
 * delimiters before querying `gh search` (the raw `<!-- … -->` form never
 * matches the index — Story #4657).
 *
 * @param {number} epicId
 * @param {number} index — zero-based finding ordinal within the Epic.
 * @returns {string}
 */
export function buildIdempotencyMarker(epicId, index) {
  return `<!-- audit-results-followup: epic-${epicId}-finding-${index} -->`;
}

/**
 * Build the content-hash idempotency marker embedded in freshly filed
 * follow-up bodies. Derived from the finding's `lens|path|summary` triple
 * so the marker is stable across sibling insert/remove/reorder churn in
 * the source `audit-results` comment (Story #4415). An HTML comment so it
 * survives markdown rendering without leaking into the visible body; the
 * idempotency probe strips the comment delimiters before querying
 * `gh search` (the raw `<!-- … -->` form never matches the index —
 * Story #4657).
 *
 * @param {number} epicId
 * @param {{ lens?: string, path?: string, summary?: string }} finding
 * @returns {string}
 */
export function buildContentMarker(epicId, finding) {
  const fp = contentFingerprint({
    category: finding.lens,
    path: finding.path,
    title: finding.summary,
  });
  return `<!-- audit-results-followup: epic-${epicId}-${fp} -->`;
}

/**
 * Project a graduator audit finding onto the canonical identity the shared
 * dedup helper (`lib/findings/route-finding.js`) fingerprints over, so a
 * close-time graduator filing and a sweep-time `/audit-to-stories` filing
 * share ONE identity namespace (Story #4626). The graduator's `lens`
 * (`audit-<dimension>`) maps to the identity `area`; its cited `path` is the
 * primary file; its `summary` is the title. Historically the graduator only
 * stamped its own content-hash `audit-results-followup` marker, disjoint from
 * route-finding's `audit-fingerprints` footer — so a `/audit-to-stories`
 * sweep could not recognize a graduator-filed issue and would re-file it.
 *
 * @param {{ lens?: string, path?: string, summary?: string }} finding
 * @returns {{ title: string, area: string, primaryFile: string, severity: string, labels: string[] }}
 */
export function toCanonicalFinding(finding) {
  const lens = typeof finding?.lens === 'string' ? finding.lens : '';
  return {
    title: typeof finding?.summary === 'string' ? finding.summary : '',
    area: lens,
    primaryFile: typeof finding?.path === 'string' ? finding.path : '',
    severity: '',
    labels: lens ? [lens] : [],
  };
}

/**
 * Render the canonical `audit-fingerprints` (and location-based
 * `audit-semantic-keys`) footer for a graduator finding, computed off the
 * shared helper's canonical hash. Stamped into every filed follow-up body so
 * the `/audit-to-stories` dedup probe recognizes a graduator-filed issue
 * (Story #4626).
 *
 * @param {{ lens?: string, path?: string, summary?: string }} finding
 * @returns {string}
 */
export function canonicalFingerprintFooter(finding) {
  const canonical = toCanonicalFinding(finding);
  const { full } = fingerprintFinding(canonical);
  const key = semanticKeyFor(canonical);
  const lines = [fingerprintFooter(full)];
  if (key) lines.push(semanticKeyFooter(key));
  return lines.join('\n');
}

/**
 * Parse the rendered audit-results markdown into a list of findings.
 * The format produced by `epic-audit.md` Step 4 groups findings under
 * `#### <lens-name>` headings; each finding line begins with a severity
 * emoji and embeds the cited path inside backticks. 🔴 critical findings
 * are filtered out (they're blocking — the Epic stops on those).
 *
 * Findings the Phase 4 remediation loop already fixed on-branch are
 * rendered under a **"Fixed on-branch"** heading (Story #4399) with a ✅
 * prefix so they no longer parse as open findings. As a belt-and-suspenders
 * guard the parser also skips every line inside a Fixed-on-branch section
 * outright, so a remediated 🟡 Medium never spawns a ghost follow-up issue
 * even if its line retains its original severity emoji.
 *
 * Pure. Exported so the parser can be unit-tested in isolation.
 *
 * @param {string} body
 * @returns {Array<{ severity: 'high'|'medium'|'low'|'suggestion', lens: string, path: string, summary: string, index: number }>}
 */
export function parseFindings(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const findings = [];
  const lines = body.split(/\r?\n/);
  let idx = 0;
  let lens = 'unknown';
  let inFixedSection = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    // Any markdown heading resets the Fixed-on-branch guard and, when it
    // names a known audit family (`audit-*`), sets the active lens. A
    // "Fixed on-branch" heading opens a section whose entries never
    // graduate (Story #4399).
    const headingMatch = trimmed.match(/^#{2,6}\s+(.+)$/);
    if (headingMatch) {
      inFixedSection = /fixed on-branch/i.test(headingMatch[1]);
      const lensMatch = headingMatch[1].match(/^(audit-[a-z0-9-]+)/i);
      if (lensMatch) lens = lensMatch[1];
      continue;
    }

    if (inFixedSection) continue;

    let severity = null;
    if (trimmed.startsWith('🔴')) {
      // Critical Blocker — skip; never graduates.
      continue;
    }
    if (trimmed.startsWith('🟠')) severity = 'high';
    else if (trimmed.startsWith('🟡')) severity = 'medium';
    else if (trimmed.startsWith('🟢')) severity = 'suggestion';
    else if (trimmed.startsWith('🔵')) severity = 'low';
    else continue;

    const pathMatch = trimmed.match(/`([^`]+)`/);
    if (!pathMatch) continue;
    const path = pathMatch[1];

    findings.push({
      severity,
      lens,
      path,
      summary: trimmed,
      index: idx,
    });
    idx += 1;
  }
  return findings;
}

/**
 * Auto-graduate non-blocking audit-results findings into routed
 * follow-up issues. Never throws. Thin wrapper around the shared
 * `graduate()` walk with the audit-specific behaviour bundle.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider — ticketing provider exposing
 *   `getTicketComments(ticketId)`.
 * @param {object} [opts.config] — resolved agentrc.
 * @param {{owner: string, repo: string}} opts.currentRepo — repo the
 *   listener is running inside; used for the cross-repo guard.
 * @param {{owner: string, repo: string}} [opts.frameworkRepo] — where
 *   framework-tagged findings route. Defaults to `currentRepo`.
 * @param {string} [opts.gitRef='HEAD']
 * @param {Function} [opts.classifier=classifyPathSource]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @returns {Promise<{
 *   filed: Array<{ index: number, severity: string, lens: string, path: string, source: string, repo: string, url: string|null }>,
 *   skipped: Array<{ index?: number, reason: string, path?: string, severity?: string, lens?: string }>,
 *   errors: string[],
 * }>}
 */
export async function graduateAuditResults(opts = {}) {
  return graduate({
    ...opts,
    spec: {
      fnName: 'graduateAuditResults',
      isAutoFileEnabled,
      commentMarker: VERIFICATION_RESULTS_MARKER,
      noCommentReason: NO_VERIFICATION_RESULTS_COMMENT_REASON,
      parseFindings,
      buildContentMarker,
      buildLegacyMarker: buildIdempotencyMarker,
      crossRepoCommentAttrs: { graduator: 'audit-results' },
      decorateRecord: (record, finding) => {
        record.lens = finding.lens;
        return record;
      },
      buildCrossRepoLog: ({ finding, routedRepo, source }) => {
        const labels = [
          'meta::audit-finding',
          metaSourceLabel(source),
          SEVERITY_LABEL[finding.severity],
          `domain::${finding.lens}`,
        ];
        return `[audit-results-graduator] cross-repo skip (would file in ${routedRepo.owner}/${routedRepo.repo}): gh issue create --repo ${routedRepo.owner}/${routedRepo.repo} --title "Audit follow-up (${finding.lens}): ${finding.path}" --label "${labels.join(',')}"`;
      },
      buildFollowUp: ({ finding, source, epicId, idMarker }) => {
        const title = `Audit follow-up (${finding.lens}): ${finding.path}`;
        const body = [
          idMarker,
          '',
          `Auto-filed from the Epic #${epicId} audit-results pass.`,
          '',
          `**Lens**: ${finding.lens}`,
          `**Severity**: ${finding.severity}`,
          `**Source**: ${source}`,
          `**Path**: \`${finding.path}\``,
          '',
          '### Finding',
          '',
          finding.summary,
          '',
          `_See Epic #${epicId} for the full audit-results report._`,
          '',
          // Canonical dedup identity so the `/audit-to-stories` sweep-time
          // probe recognizes this close-time filing and never re-files it
          // (Story #4626). The content-hash `audit-results-followup` marker
          // above stays the graduator's own re-file guard.
          canonicalFingerprintFooter(finding),
        ].join('\n');
        const labels = [
          'meta::audit-finding',
          metaSourceLabel(source),
          SEVERITY_LABEL[finding.severity],
          `domain::${finding.lens}`,
        ];
        return { title, body, labels };
      },
    },
  });
}

export default graduateAuditResults;
