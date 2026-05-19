/**
 * prior-feedback-fetcher.js — gh-CLI-backed fetcher for open meta feedback
 * issues that feed the `/epic-plan` Phase 0 planner context.
 *
 * Story #2554 / Epic #2547. Tech Spec #2550 specifies that the fetcher MUST
 * return open issues carrying the `meta::framework-gap` and
 * `meta::consumer-improvement` labels, dedupe by issue number across the two
 * arrays, and tolerate every error path (missing `gh` binary, unreachable
 * repo, non-zero exit) by appending to a structured `errors[]` list — the
 * function never throws.
 *
 * Tests inject a `spawnImpl` (or shape-compatible `execImpl`) to exercise
 * the gh-exec surface deterministically; production code defaults to
 * `child_process.spawn`.
 */

import { spawn as defaultSpawn } from 'node:child_process';

import { META_LABELS } from '../label-constants.js';

const DEFAULT_LIMIT = 50;

/**
 * Spawn the given gh CLI with the supplied args and resolve to
 * `{ code, stdout, stderr, spawnError }`. Mirrors the narrow surface of
 * `gh-exec.js#exec` but stays in-module to keep the dependency graph thin —
 * the fetcher only needs JSON-mode reads and structured error capture.
 *
 * Never throws: spawn-time errors are captured as `spawnError` so the caller
 * can classify and surface them through the `errors[]` envelope.
 *
 * @param {object} opts
 * @param {string} opts.ghPath — path to the gh binary (e.g. "gh")
 * @param {string[]} opts.args — positional + flag arguments
 * @param {Function} [opts.spawnImpl] — test seam; defaults to node:child_process spawn
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, spawnError: Error|null }>}
 */
function runGh({ ghPath, args, spawnImpl = defaultSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(ghPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
 * Build a human-readable error message for a failed gh invocation.
 *
 * @param {string} label — the meta label being fetched
 * @param {{ code: number|null, stderr: string, spawnError: Error|null }} result
 * @returns {string}
 */
function formatGhError(label, { code, stderr, spawnError }) {
  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      return `gh CLI not found while fetching label "${label}": ${spawnError.message}`;
    }
    return `gh CLI spawn failed while fetching label "${label}": ${spawnError.message}`;
  }
  const trimmed = (stderr || '').trim();
  return `gh exited with code ${code} while fetching label "${label}"${
    trimmed ? `: ${trimmed}` : ''
  }`;
}

/**
 * Normalize a single issue record returned by `gh issue list --json`. We keep
 * the shape narrow on purpose: planner context payloads ride on top of an
 * already-budgeted envelope, and trimming early avoids any ambient assumption
 * that downstream consumers can rely on extra fields.
 *
 * @param {object} raw
 * @returns {{ number: number, title: string, url: string, labels: string[] }|null}
 */
function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = typeof raw.number === 'number' ? raw.number : null;
  if (number === null) return null;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const url = typeof raw.url === 'string' ? raw.url : '';
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((l) => (l && typeof l === 'object' ? l.name : l))
        .filter((name) => typeof name === 'string')
    : [];
  return { number, title, url, labels };
}

/**
 * Fetch open issues for a single meta label via `gh issue list`. Errors are
 * captured rather than thrown.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.label
 * @param {string} opts.ghPath
 * @param {number} opts.limit
 * @param {Function} [opts.spawnImpl]
 * @returns {Promise<{ issues: object[], error: string|null }>}
 */
async function fetchByLabel({ owner, repo, label, ghPath, limit, spawnImpl }) {
  const args = [
    'issue',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'open',
    '--label',
    label,
    '--json',
    'number,title,labels,url',
    '--limit',
    String(limit),
  ];

  const result = await runGh({ ghPath, args, spawnImpl });

  if (result.spawnError || (typeof result.code === 'number' && result.code !== 0)) {
    return { issues: [], error: formatGhError(label, result) };
  }

  try {
    const parsed = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(parsed)) {
      return {
        issues: [],
        error: `gh issue list returned non-array JSON for label "${label}"`,
      };
    }
    const issues = parsed
      .map(normalizeIssue)
      .filter((issue) => issue !== null);
    return { issues, error: null };
  } catch (err) {
    return {
      issues: [],
      error: `Failed to parse gh issue list JSON for label "${label}": ${err.message}`,
    };
  }
}

/**
 * Fetch the union of open issues carrying either `meta::framework-gap` or
 * `meta::consumer-improvement` and split them into two arrays. Issues that
 * carry **both** labels appear in `frameworkGaps` only — dedupe-by-number
 * runs across both arrays so the planner sees each issue exactly once.
 *
 * The returned envelope is best-effort: every failure mode (gh missing, repo
 * not found, non-zero exit, malformed JSON) is captured as a string in
 * `errors[]`. The function never throws.
 *
 * @param {object} opts
 * @param {string} opts.owner — GitHub owner (e.g. "dsj1984")
 * @param {string} opts.repo  — GitHub repo (e.g. "mandrel")
 * @param {string} [opts.ghPath="gh"] — path to the gh binary
 * @param {number} [opts.limit=50] — per-label `--limit` passed to gh
 * @param {Function} [opts.spawnImpl] — test seam for node:child_process spawn
 * @returns {Promise<{
 *   frameworkGaps: object[],
 *   consumerImprovements: object[],
 *   fetchedAt: string,
 *   errors: string[],
 * }>}
 */
export async function fetchPriorFeedback({
  owner,
  repo,
  ghPath = 'gh',
  limit = DEFAULT_LIMIT,
  spawnImpl,
} = {}) {
  const errors = [];

  if (typeof owner !== 'string' || owner.trim() === '') {
    errors.push('fetchPriorFeedback: missing required "owner" argument');
  }
  if (typeof repo !== 'string' || repo.trim() === '') {
    errors.push('fetchPriorFeedback: missing required "repo" argument');
  }

  const envelope = {
    frameworkGaps: [],
    consumerImprovements: [],
    fetchedAt: new Date().toISOString(),
    errors,
  };

  if (errors.length > 0) return envelope;

  const [gapsResult, improvementsResult] = await Promise.all([
    fetchByLabel({
      owner,
      repo,
      label: META_LABELS.FRAMEWORK_GAP,
      ghPath,
      limit,
      spawnImpl,
    }),
    fetchByLabel({
      owner,
      repo,
      label: META_LABELS.CONSUMER_IMPROVEMENT,
      ghPath,
      limit,
      spawnImpl,
    }),
  ]);

  if (gapsResult.error) errors.push(gapsResult.error);
  if (improvementsResult.error) errors.push(improvementsResult.error);

  // Dedupe by issue number across both arrays. Issues that carry both labels
  // land in frameworkGaps first (deterministic) and are filtered out of
  // consumerImprovements.
  const seen = new Set();
  for (const issue of gapsResult.issues) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    envelope.frameworkGaps.push(issue);
  }
  for (const issue of improvementsResult.issues) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    envelope.consumerImprovements.push(issue);
  }

  return envelope;
}

export default fetchPriorFeedback;
