/**
 * audit-results-graduator.js — Auto-graduate non-blocking audit findings
 * from the Epic's `audit-results` structured comment into routed GitHub
 * follow-up issues. Story #2615 / Epic #2586.
 *
 * Mirrors the surface and contract of `code-review-graduator.js` (Story
 * #2555):
 *
 *   - Read the `audit-results` structured comment off the Epic ticket
 *     via the injected provider (`getTicketComments`).
 *   - For each non-blocking finding (severity high/medium/low/suggestion
 *     — i.e. anything that is NOT a 🔴 Critical Blocker), check that
 *     the cited file still exists in the merged tree.
 *   - Route by source classification (framework vs consumer) using
 *     `classifyPathSource`. Cross-repo findings are recorded under
 *     `skipped: 'cross-repo-deferred'` and the would-be `gh issue
 *     create` invocation is logged — never shelled out across repos.
 *   - File a follow-up issue with `gh issue create` carrying:
 *       - `type::task`
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

import { spawn as defaultSpawn } from 'node:child_process';

import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';

/**
 * Resolve the toggle from the resolved agentrc config. Defaults to `true`
 * — the feature is opt-out, not opt-in (mirrors codeReviewAutoFile).
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export function isAutoFileEnabled(config) {
  const value = config?.delivery?.feedbackLoop?.auditResultsAutoFile;
  if (value === false) return false;
  return true;
}

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
 * Build the idempotency marker for a given epicId / finding index. An
 * HTML comment so it survives markdown rendering without leaking into
 * the visible body, but stays indexable via `gh search`.
 *
 * @param {number} epicId
 * @param {number} index — zero-based finding ordinal within the Epic.
 * @returns {string}
 */
export function buildIdempotencyMarker(epicId, index) {
  return `<!-- audit-results-followup: epic-${epicId}-finding-${index} -->`;
}

/**
 * Parse the rendered audit-results markdown into a list of findings.
 * The format produced by `epic-audit.md` Step 4 groups findings under
 * `#### <lens-name>` headings; each finding line begins with a severity
 * emoji and embeds the cited path inside backticks. 🔴 critical findings
 * are filtered out (they're blocking — the Epic stops on those).
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
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    // Detect a lens heading. We accept any heading-prefixed line that
    // names a known audit family (`audit-*`).
    const lensMatch = trimmed.match(/^#{2,6}\s+(audit-[a-z0-9-]+)/i);
    if (lensMatch) {
      lens = lensMatch[1];
      continue;
    }

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
 * Spawn a child process and resolve to `{ code, stdout, stderr, spawnError }`.
 * Never throws — spawn-time errors are captured as `spawnError`.
 */
function runChild({ cmd, args, spawnImpl = defaultSpawn, cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, spawnError });
    });
  });
}

/**
 * Probe whether the cited path exists in the merged tree at the given
 * git ref via `git cat-file -e <ref>:<path>`.
 */
export async function probePathExists({ ref, path, spawnImpl, cwd }) {
  const res = await runChild({
    cmd: 'git',
    args: ['cat-file', '-e', `${ref}:${path}`],
    spawnImpl,
    cwd,
  });
  return res.code === 0;
}

async function probeMarkerExists({
  marker,
  owner,
  repo,
  ghPath,
  spawnImpl,
  cwd,
}) {
  const args = [
    'search',
    'issues',
    marker,
    '--repo',
    `${owner}/${repo}`,
    '--json',
    'number',
    '--limit',
    '1',
  ];
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return false;
  }
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

async function createFollowUpIssue({
  owner,
  repo,
  title,
  body,
  labels,
  ghPath,
  spawnImpl,
  cwd,
}) {
  const args = [
    'issue',
    'create',
    '--repo',
    `${owner}/${repo}`,
    '--title',
    title,
    '--body',
    body,
  ];
  for (const label of labels) {
    args.push('--label', label);
  }
  const res = await runChild({ cmd: ghPath, args, spawnImpl, cwd });
  if (res.spawnError || (typeof res.code === 'number' && res.code !== 0)) {
    return {
      url: null,
      error: res.spawnError
        ? `gh issue create spawn failed: ${res.spawnError.message}`
        : `gh issue create exited ${res.code}: ${(res.stderr || '').trim()}`,
    };
  }
  const url = (res.stdout || '').trim();
  return { url, error: null };
}

/**
 * Auto-graduate non-blocking audit-results findings into routed
 * follow-up issues. Never throws.
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
export async function graduateAuditResults({
  epicId,
  provider,
  config,
  currentRepo,
  frameworkRepo,
  gitRef = 'HEAD',
  classifier = defaultClassifier,
  ghPath = 'gh',
  spawnImpl,
  cwd,
  logger,
} = {}) {
  const envelope = { filed: [], skipped: [], errors: [] };

  if (!isAutoFileEnabled(config)) {
    envelope.skipped.push({ reason: 'toggle-disabled' });
    return envelope;
  }

  if (!Number.isInteger(epicId) || epicId < 1) {
    envelope.errors.push('graduateAuditResults: missing or invalid epicId');
    return envelope;
  }
  if (!provider || typeof provider.getTicketComments !== 'function') {
    envelope.errors.push(
      'graduateAuditResults: provider lacks getTicketComments',
    );
    return envelope;
  }
  if (
    !currentRepo ||
    typeof currentRepo.owner !== 'string' ||
    typeof currentRepo.repo !== 'string'
  ) {
    envelope.errors.push(
      'graduateAuditResults: missing currentRepo {owner,repo}',
    );
    return envelope;
  }

  // 1. Read the audit-results comment off the Epic.
  let comments;
  try {
    comments = await provider.getTicketComments(epicId);
  } catch (err) {
    envelope.errors.push(
      `getTicketComments failed for epic #${epicId}: ${err?.message ?? err}`,
    );
    return envelope;
  }
  if (!Array.isArray(comments) || comments.length === 0) {
    envelope.skipped.push({ reason: 'no-audit-results-comment' });
    return envelope;
  }
  // The audit-results comment uses the `claude-managed: audit-results`
  // marker (see `.agents/workflows/helpers/epic-audit.md` Step 4 and
  // tests/audit-suite/epic-audit-helper.test.js).
  const marker = '<!-- claude-managed: audit-results -->';
  const matched = comments.filter(
    (c) => typeof c?.body === 'string' && c.body.includes(marker),
  );
  if (matched.length === 0) {
    envelope.skipped.push({ reason: 'no-audit-results-comment' });
    return envelope;
  }
  const auditComment = matched[matched.length - 1];

  // 2. Parse findings.
  const findings = parseFindings(auditComment.body);
  if (findings.length === 0) {
    envelope.skipped.push({ reason: 'no-non-blocking-findings' });
    return envelope;
  }

  // 3. For each finding, route → idempotency probe → file.
  for (const finding of findings) {
    const exists = await probePathExists({
      ref: gitRef,
      path: finding.path,
      spawnImpl,
      cwd,
    });
    if (!exists) {
      envelope.skipped.push({
        index: finding.index,
        reason: 'file-removed',
        path: finding.path,
        severity: finding.severity,
        lens: finding.lens,
      });
      continue;
    }

    const source = classifier(finding.path, null);
    const metaSourceLabel =
      source === 'framework'
        ? 'meta::framework-gap'
        : 'meta::consumer-improvement';
    const routedRepo =
      source === 'framework' && frameworkRepo ? frameworkRepo : currentRepo;

    const isCrossRepo =
      routedRepo.owner !== currentRepo.owner ||
      routedRepo.repo !== currentRepo.repo;
    if (isCrossRepo) {
      const labels = [
        'type::task',
        'meta::audit-finding',
        metaSourceLabel,
        SEVERITY_LABEL[finding.severity],
        `domain::${finding.lens}`,
      ];
      const wouldBeCmd = `gh issue create --repo ${routedRepo.owner}/${routedRepo.repo} --title "Audit follow-up (${finding.lens}): ${finding.path}" --label "${labels.join(',')}"`;
      logger?.info?.(
        `[audit-results-graduator] cross-repo skip (would file in ${routedRepo.owner}/${routedRepo.repo}): ${wouldBeCmd}`,
      );
      envelope.skipped.push({
        index: finding.index,
        reason: 'cross-repo-deferred',
        path: finding.path,
        severity: finding.severity,
        lens: finding.lens,
      });
      continue;
    }

    const idMarker = buildIdempotencyMarker(epicId, finding.index);
    const alreadyFiled = await probeMarkerExists({
      marker: idMarker,
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      ghPath,
      spawnImpl,
      cwd,
    });
    if (alreadyFiled) {
      envelope.skipped.push({
        index: finding.index,
        reason: 'already-filed',
        path: finding.path,
        severity: finding.severity,
        lens: finding.lens,
      });
      continue;
    }

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
    ].join('\n');
    const labels = [
      'type::task',
      'meta::audit-finding',
      metaSourceLabel,
      SEVERITY_LABEL[finding.severity],
      `domain::${finding.lens}`,
    ];
    const created = await createFollowUpIssue({
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      title,
      body,
      labels,
      ghPath,
      spawnImpl,
      cwd,
    });
    if (created.error) {
      envelope.errors.push(
        `finding ${finding.index} (${finding.path}): ${created.error}`,
      );
      continue;
    }
    envelope.filed.push({
      index: finding.index,
      severity: finding.severity,
      lens: finding.lens,
      path: finding.path,
      source,
      repo: `${routedRepo.owner}/${routedRepo.repo}`,
      url: created.url,
    });
  }

  return envelope;
}

export default graduateAuditResults;
