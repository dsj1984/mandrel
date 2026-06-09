/**
 * graduator-core.js — shared mechanism for the feedback-loop graduators.
 *
 * Story #3845 / Epic #3823. The audit-results graduator
 * (`audit-results-graduator.js`) and the code-review graduator
 * (`code-review-graduator.js`) duplicated ~90% of their mechanism: a
 * `spawn`-based child runner, the `git cat-file` path probe, the
 * `gh search issues` idempotency probe, the `gh issue create` filer, the
 * `isAutoFileEnabled` toggle reader, and the route → probe → file
 * envelope walk. This module folds all of that into one place so the two
 * graduators become thin shells that inject the bits that genuinely
 * differ (the finding parser and the body/title/label builders).
 *
 * The third `runGh` spawn copy in `prior-feedback-fetcher.js` is also
 * collapsed onto the single `runChild` helper here.
 *
 * Behaviour-preserving: the parametrized `graduate()` walk reproduces the
 * exact envelope, skip reasons, label sets, titles, and bodies the two
 * standalone graduators produced before consolidation. The only injected
 * seams are the parser (`parseFindings`) and the per-finding
 * `bodyBuilder`; everything mechanical is shared.
 */

import { spawn as defaultSpawn } from 'node:child_process';

import { classifyPathSource as defaultClassifier } from '../observability/source-classifier.js';

/**
 * Spawn a child process and resolve to `{ code, stdout, stderr, spawnError }`.
 * Never throws — spawn-time errors are captured as `spawnError`.
 *
 * This is the single spawn helper for the feedback-loop modules. Both
 * graduators and `prior-feedback-fetcher.js` route their child-process
 * reads through it so the error envelope stays consistent. `stdio` is
 * always `['ignore', 'pipe', 'pipe']`; callers that need extra spawn
 * options (e.g. omitting `cwd`) pass `undefined` and the option is
 * dropped by the child_process layer.
 *
 * @param {object} opts
 * @param {string} opts.cmd — binary to spawn (e.g. "git", "gh")
 * @param {string[]} opts.args — positional + flag arguments
 * @param {Function} [opts.spawnImpl] — test seam; defaults to node:child_process spawn
 * @param {string} [opts.cwd] — working directory for the child
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, spawnError: Error|null }>}
 */
export function runChild({ cmd, args, spawnImpl = defaultSpawn, cwd }) {
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
 * Build an `isAutoFileEnabled(config)` reader bound to a specific
 * `delivery.feedbackLoop.<key>` toggle. The feature is opt-out: the
 * toggle defaults to `true` and only an explicit `false` disables it.
 *
 * @param {string} toggleKey — key under `config.delivery.feedbackLoop`
 *   (e.g. "auditResultsAutoFile", "codeReviewAutoFile")
 * @returns {(config: object|undefined|null) => boolean}
 */
export function makeIsAutoFileEnabled(toggleKey) {
  return function isAutoFileEnabled(config) {
    const value = config?.delivery?.feedbackLoop?.[toggleKey];
    if (value === false) return false;
    return true;
  };
}

/**
 * Probe whether the cited path exists in the merged tree at the given
 * git ref via `git cat-file -e <ref>:<path>`. Resolves `true` when the
 * file is present, `false` otherwise — a spawn failure degrades to
 * `false` (we cannot prove existence, so the finding skips with
 * `file-removed`).
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
 * a duplicate than swallow the finding entirely).
 */
export async function probeMarkerExists({
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
 * File a new follow-up issue via `gh issue create` and resolve to
 * `{ url, error }`. On success `url` is the trimmed stdout and `error` is
 * null; on failure `url` is null and `error` carries a human-readable
 * message.
 */
export async function createFollowUpIssue({
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
 * Parametrized graduator walk. Reads the Epic's structured comment via
 * the injected provider, parses non-blocking findings with the injected
 * `parseFindings`, then for each finding runs the shared route → path
 * probe → idempotency probe → file sequence. Never throws — every
 * failure path is captured in `errors[]`.
 *
 * The per-graduator variation lives entirely in the injected callbacks:
 *
 *   - `parseFindings(body)` — turns the rendered comment into findings.
 *     Each finding MUST carry `{ severity, path, summary, index }` and
 *     MAY carry additional fields (e.g. `lens`) that the builder uses.
 *   - `buildIdempotencyMarker(epicId, index)` — the HTML-comment marker
 *     embedded in (and searched for in) follow-up bodies.
 *   - `buildFollowUp({ finding, source, epicId })` — returns
 *     `{ title, body, labels }` for the issue to file.
 *   - `buildCrossRepoLog({ finding, routedRepo })` — returns the
 *     human-readable would-be-command string logged on a cross-repo skip.
 *   - `decorateRecord(record, finding)` — copies finding-specific fields
 *     (e.g. `lens`) onto a `skipped`/`filed` record before it is pushed.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {object} opts.provider — exposes `getTicketComments(ticketId)`
 * @param {object} [opts.config]
 * @param {{owner: string, repo: string}} opts.currentRepo
 * @param {{owner: string, repo: string}} [opts.frameworkRepo]
 * @param {string} [opts.gitRef='HEAD']
 * @param {Function} [opts.classifier=classifyPathSource]
 * @param {string} [opts.ghPath='gh']
 * @param {Function} [opts.spawnImpl]
 * @param {string} [opts.cwd]
 * @param {{info?: Function, warn?: Function, debug?: Function}} [opts.logger]
 * @param {object} opts.spec — the per-graduator behaviour bundle
 * @param {string} opts.spec.fnName — name used in error-message prefixes
 * @param {(config: object|undefined|null) => boolean} opts.spec.isAutoFileEnabled
 * @param {string} opts.spec.commentMarker — structured-comment marker to match
 * @param {string} opts.spec.noCommentReason — skip reason when absent
 * @param {Function} opts.spec.parseFindings
 * @param {(epicId: number, index: number) => string} opts.spec.buildIdempotencyMarker
 * @param {Function} opts.spec.buildFollowUp
 * @param {Function} opts.spec.buildCrossRepoLog
 * @param {(record: object, finding: object) => object} [opts.spec.decorateRecord]
 * @returns {Promise<{ filed: object[], skipped: object[], errors: string[] }>}
 */
export async function graduate({
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
  spec,
}) {
  const envelope = { filed: [], skipped: [], errors: [] };
  const decorate =
    typeof spec.decorateRecord === 'function'
      ? spec.decorateRecord
      : (record) => record;

  if (!spec.isAutoFileEnabled(config)) {
    envelope.skipped.push({ reason: 'toggle-disabled' });
    return envelope;
  }

  if (!Number.isInteger(epicId) || epicId < 1) {
    envelope.errors.push(`${spec.fnName}: missing or invalid epicId`);
    return envelope;
  }
  if (!provider || typeof provider.getTicketComments !== 'function') {
    envelope.errors.push(`${spec.fnName}: provider lacks getTicketComments`);
    return envelope;
  }
  if (
    !currentRepo ||
    typeof currentRepo.owner !== 'string' ||
    typeof currentRepo.repo !== 'string'
  ) {
    envelope.errors.push(`${spec.fnName}: missing currentRepo {owner,repo}`);
    return envelope;
  }

  // 1. Read the structured comment off the Epic.
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
    envelope.skipped.push({ reason: spec.noCommentReason });
    return envelope;
  }
  const matched = comments.filter(
    (c) => typeof c?.body === 'string' && c.body.includes(spec.commentMarker),
  );
  if (matched.length === 0) {
    envelope.skipped.push({ reason: spec.noCommentReason });
    return envelope;
  }
  const sourceComment = matched[matched.length - 1];

  // 2. Parse findings.
  const findings = spec.parseFindings(sourceComment.body);
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
      envelope.skipped.push(
        decorate(
          {
            index: finding.index,
            reason: 'file-removed',
            path: finding.path,
            severity: finding.severity,
          },
          finding,
        ),
      );
      continue;
    }

    const source = classifier(finding.path, null);
    const routedRepo =
      source === 'framework' && frameworkRepo ? frameworkRepo : currentRepo;

    const isCrossRepo =
      routedRepo.owner !== currentRepo.owner ||
      routedRepo.repo !== currentRepo.repo;
    if (isCrossRepo) {
      logger?.info?.(spec.buildCrossRepoLog({ finding, routedRepo, source }));
      envelope.skipped.push(
        decorate(
          {
            index: finding.index,
            reason: 'cross-repo-deferred',
            path: finding.path,
            severity: finding.severity,
          },
          finding,
        ),
      );
      continue;
    }

    const idMarker = spec.buildIdempotencyMarker(epicId, finding.index);
    const alreadyFiled = await probeMarkerExists({
      marker: idMarker,
      owner: routedRepo.owner,
      repo: routedRepo.repo,
      ghPath,
      spawnImpl,
      cwd,
    });
    if (alreadyFiled) {
      envelope.skipped.push(
        decorate(
          {
            index: finding.index,
            reason: 'already-filed',
            path: finding.path,
            severity: finding.severity,
          },
          finding,
        ),
      );
      continue;
    }

    const { title, body, labels } = spec.buildFollowUp({
      finding,
      source,
      epicId,
      idMarker,
    });
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
    envelope.filed.push(
      decorate(
        {
          index: finding.index,
          severity: finding.severity,
          path: finding.path,
          source,
          repo: `${routedRepo.owner}/${routedRepo.repo}`,
          url: created.url,
        },
        finding,
      ),
    );
  }

  return envelope;
}
