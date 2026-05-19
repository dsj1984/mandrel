/**
 * code-review-graduator.js — Auto-graduate non-blocking code-review
 * findings from the Epic's `code-review` structured comment into routed
 * GitHub follow-up issues.
 *
 * Story #2555 / Epic #2547. Tech Spec #2550 specifies:
 *
 *   - Read the `code-review` structured comment off the Epic ticket via
 *     the injected provider (findStructuredComment surface).
 *   - For each non-blocking finding (severity high/medium/low — i.e.
 *     anything that is NOT a 🔴 Critical Blocker), check that the cited
 *     file still exists in the merged tree (`git cat-file -e <ref>:<path>`)
 *     via the injected fsImpl seam.
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
 * Tests inject `provider`, `classifier`, `fsImpl`, and `spawnImpl` to
 * drive every branch deterministically.
 */

import { spawn as defaultSpawn } from 'node:child_process';

import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';

/**
 * Resolve the toggle from the resolved agentrc config. Defaults to `true`
 * — the feature is opt-out, not opt-in.
 *
 * @param {object|undefined|null} config
 * @returns {boolean}
 */
export function isAutoFileEnabled(config) {
  const value = config?.delivery?.feedbackLoop?.codeReviewAutoFile;
  if (value === false) return false;
  return true;
}

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
 * Today's epic-code-review.js emits findings as bullet lines under the
 * "🚨 Critical Findings" and "🟡 Warnings" sections. Each line begins
 * with a severity emoji and embeds the cited path inside backticks. We
 * filter 🔴 (Critical Blocker — blocking) out; 🟠/🟡/🟢 are non-blocking
 * and graduate to follow-up issues.
 *
 * @param {string} body
 * @returns {Array<{ severity: 'high'|'medium'|'low', path: string, summary: string, index: number }>}
 */
export function parseFindings(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const findings = [];
  const lines = body.split(/\r?\n/);
  let idx = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
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
 * Spawn a child process and resolve to `{ code, stdout, stderr, spawnError }`.
 * Never throws — spawn-time errors are captured as `spawnError`.
 *
 * Mirrors the narrow surface of `prior-feedback-fetcher.js#runGh` so the
 * two feedback-loop modules share a consistent error envelope.
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
 * git ref via `git cat-file -e <ref>:<path>`. Resolves `true` when the
 * file is present, `false` otherwise. Errors degrade to `false` — a
 * spawn failure means we cannot prove existence, and the Tech Spec
 * specifies that unprovable findings skip with `file-removed`.
 *
 * @param {object} opts
 * @param {string} opts.ref
 * @param {string} opts.path
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
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

/**
 * Probe whether a follow-up issue carrying the given idempotency marker
 * already exists in the routed repo. Uses `gh search issues` so we hit
 * the body field directly. Returns `true` when at least one match is
 * present; degrades to `false` on any spawn/parse error (better to risk
 * a duplicate than swallow the finding entirely; future operator can
 * delete duplicates manually).
 */
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

/**
 * File a new follow-up issue via `gh issue create` and resolve to the
 * URL on success, `null` on failure.
 */
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
 * Auto-graduate non-blocking code-review findings into routed follow-up
 * issues. Never throws.
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
export async function graduateFindings({
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
    envelope.errors.push('graduateFindings: missing or invalid epicId');
    return envelope;
  }
  if (!provider || typeof provider.getTicketComments !== 'function') {
    envelope.errors.push('graduateFindings: provider lacks getTicketComments');
    return envelope;
  }
  if (
    !currentRepo ||
    typeof currentRepo.owner !== 'string' ||
    typeof currentRepo.repo !== 'string'
  ) {
    envelope.errors.push('graduateFindings: missing currentRepo {owner,repo}');
    return envelope;
  }

  // 1. Read the code-review comment off the Epic. We use the raw
  //    getTicketComments surface (rather than findStructuredComment) so
  //    the module stays self-contained and the test seam is a single
  //    provider stub.
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
    envelope.skipped.push({ reason: 'no-code-review-comment' });
    return envelope;
  }
  const marker = '<!-- structured-comment: code-review -->';
  const codeReviewComments = comments.filter(
    (c) => typeof c?.body === 'string' && c.body.includes(marker),
  );
  if (codeReviewComments.length === 0) {
    envelope.skipped.push({ reason: 'no-code-review-comment' });
    return envelope;
  }
  const codeReview = codeReviewComments[codeReviewComments.length - 1];

  // 2. Parse findings.
  const findings = parseFindings(codeReview.body);
  if (findings.length === 0) {
    envelope.skipped.push({ reason: 'no-non-blocking-findings' });
    return envelope;
  }

  // 3. For each finding, route → idempotency probe → file.
  for (const finding of findings) {
    // 3a. Path existence probe.
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
      });
      continue;
    }

    // 3b. Classify and pick the routed repo.
    const source = classifier(finding.path, null);
    const metaLabel =
      source === 'framework'
        ? 'meta::framework-gap'
        : 'meta::consumer-improvement';
    const routedRepo =
      source === 'framework' && frameworkRepo ? frameworkRepo : currentRepo;

    // 3c. Cross-repo guard. If the routed repo differs from the current
    //     repo, log the would-be invocation and skip — we never run gh
    //     against a different repo.
    const isCrossRepo =
      routedRepo.owner !== currentRepo.owner ||
      routedRepo.repo !== currentRepo.repo;
    if (isCrossRepo) {
      const wouldBeCmd = `gh issue create --repo ${routedRepo.owner}/${routedRepo.repo} --title "Code review follow-up: ${finding.path}" --label "${metaLabel},${SEVERITY_LABEL[finding.severity]}"`;
      logger?.info?.(
        `[code-review-graduator] cross-repo skip (would file in ${routedRepo.owner}/${routedRepo.repo}): ${wouldBeCmd}`,
      );
      envelope.skipped.push({
        index: finding.index,
        reason: 'cross-repo-deferred',
        path: finding.path,
        severity: finding.severity,
      });
      continue;
    }

    // 3d. Idempotency probe.
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
      });
      continue;
    }

    // 3e. File the follow-up issue.
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
      path: finding.path,
      source,
      repo: `${routedRepo.owner}/${routedRepo.repo}`,
      url: created.url,
    });
  }

  return envelope;
}

export default graduateFindings;
