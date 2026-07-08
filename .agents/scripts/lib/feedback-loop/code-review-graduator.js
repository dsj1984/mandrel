/**
 * code-review-graduator.js — Auto-graduate non-blocking code-review
 * findings from the Epic's `code-review` structured comment into routed
 * GitHub follow-up issues.
 *
 * Story #2555 / Epic #2547. As of Story #3845 / Epic #3823 the spawn
 * helper, the path/idempotency probes, the `gh issue create` filer, the
 * toggle reader, and the route → probe → file walk all live in the
 * shared [`graduator-core.js`](./graduator-core.js). This module is the
 * thin code-review-specific shell: it owns the code-review finding parser
 * (the 🟢→low severity mapping, no lens), the code-review label / title /
 * body shape, and the code-review idempotency marker. Behaviour is
 * identical to the pre-consolidation graduator.
 *
 *   - Read the `code-review` structured comment off the Epic ticket via
 *     the injected provider (findStructuredComment surface).
 *   - For each non-blocking finding (severity high/medium/low — i.e.
 *     anything that is NOT a 🔴 Critical Blocker), check that the cited
 *     file still exists in the merged tree (`git cat-file -e <ref>:<path>`)
 *     via the injected spawn seam.
 *   - Route by source classification (framework vs consumer) using
 *     `classifyPathSource` (S1 helper). When the routed repo differs
 *     from the current repo, record under `skipped: 'cross-repo-deferred'`
 *     and log the would-be `gh issue create` invocation — do NOT actually
 *     shell out against a different repo.
 *   - File a follow-up issue with `gh issue create --repo <routed-repo>`
 *     carrying a `code-review::<severity>` label plus the matching
 *     `meta::<framework-gap|consumer-improvement>` label.
 *   - Embed an idempotency marker in each body:
 *       <!-- code-review-followup: epic-<id>-finding-<idx> -->
 *     Before filing, probe via `gh search issues "<marker>" --repo …`
 *     and skip findings whose marker is already present in any issue.
 *   - Short-circuit when `config.delivery.feedbackLoop.codeReviewAutoFile`
 *     is `false` — return `{ filed: [], skipped: [{reason:
 *     'toggle-disabled'}], errors: [] }`.
 *   - NEVER throw. Every failure path (missing comment, parse failure,
 *     gh/git spawn error, non-zero exit) is captured in `errors[]`.
 *
 * Tests inject `provider`, `classifier`, and `spawnImpl` to drive every
 * branch deterministically.
 */

import {
  graduate,
  makeIsAutoFileEnabled,
  probePathExists,
} from './graduator-core.js';

/**
 * Resolve the toggle from the resolved agentrc config. Defaults to `true`
 * — the feature is opt-out, not opt-in.
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export const isAutoFileEnabled = makeIsAutoFileEnabled('codeReviewAutoFile');

// Re-export the shared path probe so existing importers keep working.
export { probePathExists };

/**
 * Severity → label mapping. Only non-blocking severities have a route;
 * 🔴 Critical Blocker is explicitly filtered out upstream.
 */
const SEVERITY_LABEL = Object.freeze({
  high: 'code-review::high',
  medium: 'code-review::medium',
  low: 'code-review::low',
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
 * Compile a marker for a given epicId / finding index. The marker is an
 * HTML comment so it survives GitHub markdown rendering without leaking
 * into the visible body — but it's still indexable via `gh search`.
 *
 * @param {number} epicId
 * @param {number} index — zero-based finding ordinal within the Epic.
 * @returns {string}
 */
export function buildIdempotencyMarker(epicId, index) {
  return `<!-- code-review-followup: epic-${epicId}-finding-${index} -->`;
}

/**
 * Parse the rendered code-review markdown into a list of findings. Each
 * finding has `{ severity, path, summary, index }`. Pure. Exported so
 * the parser can be unit-tested in isolation.
 *
 * The structured `code-review` comment emits findings as bullet lines under the
 * "🚨 Critical Findings" and "🟡 Warnings" sections. Each line begins
 * with a severity emoji and embeds the cited path inside backticks. We
 * filter 🔴 (Critical Blocker — blocking) out; 🟠/🟡/🟢 are non-blocking
 * and graduate to follow-up issues.
 *
 * Findings the Phase 5 focused-fix routing already fixed on-branch are
 * rendered under a **"Fixed on-branch"** heading (Story #4399) with a ✅
 * prefix so they no longer parse as open findings. As a belt-and-suspenders
 * guard the parser also skips every line inside a Fixed-on-branch section
 * outright, so a remediated 🟡 Medium never spawns a ghost follow-up issue
 * even if its line retains its original severity emoji.
 *
 * @param {string} body
 * @returns {Array<{ severity: 'high'|'medium'|'low', path: string, summary: string, index: number }>}
 */
export function parseFindings(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const findings = [];
  const lines = body.split(/\r?\n/);
  let idx = 0;
  let inFixedSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Any markdown heading resets the Fixed-on-branch guard; a
    // "Fixed on-branch" heading opens a section whose entries never
    // graduate (Story #4399).
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      inFixedSection = /fixed on-branch/i.test(headingMatch[1]);
      continue;
    }
    if (inFixedSection) continue;
    let severity = null;
    if (trimmed.startsWith('🟠')) severity = 'high';
    else if (trimmed.startsWith('🟡')) severity = 'medium';
    else if (trimmed.startsWith('🟢')) severity = 'low';
    else continue;
    // Path is the first backticked token on the line.
    const pathMatch = trimmed.match(/`([^`]+)`/);
    if (!pathMatch) continue;
    const path = pathMatch[1];
    // Summary is the line itself, stripped of the leading emoji bullet.
    findings.push({
      severity,
      path,
      summary: trimmed,
      index: idx,
    });
    idx += 1;
  }
  return findings;
}

/**
 * Auto-graduate non-blocking code-review findings into routed follow-up
 * issues. Never throws. Thin wrapper around the shared `graduate()` walk
 * with the code-review-specific behaviour bundle.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider — ticketing provider exposing
 *   `getTicketComments(ticketId)`.
 * @param {object} [opts.config] — resolved agentrc.
 * @param {{owner: string, repo: string}} opts.currentRepo — the repo the
 *   listener is running inside; used for the cross-repo guard.
 * @param {{owner: string, repo: string}} [opts.frameworkRepo] — where
 *   framework-tagged findings get routed. Defaults to
 *   `currentRepo` when this is the framework repo, otherwise typically
 *   `{ owner: 'dsj1984', repo: 'mandrel' }`.
 * @param {string} [opts.gitRef='HEAD'] — ref against which to probe path
 *   existence.
 * @param {Function} [opts.classifier=classifyPathSource] — S1 helper.
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @returns {Promise<{
 *   filed: Array<{ index: number, severity: string, path: string, source: string, repo: string, url: string|null }>,
 *   skipped: Array<{ index?: number, reason: string, path?: string, severity?: string }>,
 *   errors: string[],
 * }>}
 */
export async function graduateFindings(opts = {}) {
  return graduate({
    ...opts,
    spec: {
      fnName: 'graduateFindings',
      isAutoFileEnabled,
      commentMarker: '<!-- structured-comment: code-review -->',
      noCommentReason: 'no-code-review-comment',
      parseFindings,
      buildIdempotencyMarker,
      buildCrossRepoLog: ({ finding, routedRepo, source }) => {
        const metaLabel = metaSourceLabel(source);
        return `[code-review-graduator] cross-repo skip (would file in ${routedRepo.owner}/${routedRepo.repo}): gh issue create --repo ${routedRepo.owner}/${routedRepo.repo} --title "Code review follow-up: ${finding.path}" --label "${metaLabel},${SEVERITY_LABEL[finding.severity]}"`;
      },
      buildFollowUp: ({ finding, source, epicId, idMarker }) => {
        const metaLabel = metaSourceLabel(source);
        const title = `Code review follow-up: ${finding.path}`;
        const body = [
          idMarker,
          '',
          `Auto-filed from the Epic #${epicId} code-review pass.`,
          '',
          `**Severity**: ${finding.severity}`,
          `**Source**: ${source}`,
          `**Path**: \`${finding.path}\``,
          '',
          '### Finding',
          '',
          finding.summary,
          '',
          `_See Epic #${epicId} for the full code-review report._`,
        ].join('\n');
        const labels = [metaLabel, SEVERITY_LABEL[finding.severity]];
        return { title, body, labels };
      },
    },
  });
}

export default graduateFindings;
