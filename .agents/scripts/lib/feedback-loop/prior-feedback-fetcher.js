/**
 * Fetches open `meta::*` feedback issues for `/mandrel-plan` Phase 0, plus
 * the recurring `friction::<class>` counts that close the retro→planner
 * loop. Never throws; failures land in `errors[]`.
 */

import { META_LABELS } from '../label-constants.js';
import { CI_GAP_INTAKE_MARKER } from '../orchestration/ci-gap-intake.js';
import { runChild } from './graduator-core.js';

const DEFAULT_LIMIT = 50;

const FRICTION_LABEL_PREFIX = 'friction::';

/**
 * `count` is distinct open issues per class; sorted count desc, then name.
 *
 * @param {Array<{ number: number, labels?: string[] }>} issues
 * @returns {Array<{ class: string, count: number, issues: number[] }>}
 */
function extractRecurringDefectClasses(issues) {
  if (!Array.isArray(issues)) return [];
  /** @type {Map<string, Set<number>>} */
  const byClass = new Map();
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const number = typeof issue.number === 'number' ? issue.number : null;
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    for (const label of labels) {
      if (
        typeof label !== 'string' ||
        !label.startsWith(FRICTION_LABEL_PREFIX)
      ) {
        continue;
      }
      const cls = label.slice(FRICTION_LABEL_PREFIX.length).trim();
      if (cls.length === 0) continue;
      let set = byClass.get(cls);
      if (!set) {
        set = new Set();
        byClass.set(cls, set);
      }
      if (number !== null) set.add(number);
    }
  }
  const out = [];
  for (const [cls, set] of byClass) {
    out.push({
      class: cls,
      count: set.size,
      issues: [...set].sort((a, b) => a - b),
    });
  }
  out.sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.ghPath
 * @param {string[]} opts.args
 * @param {Function} [opts.spawnImpl]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, spawnError: Error|null }>}
 */
function runGh({ ghPath, args, spawnImpl }) {
  return runChild({ cmd: ghPath, args, spawnImpl });
}

/**
 * @param {string} label
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
 * Deliberately narrow: the planner envelope is budgeted. The body is fetched
 * only to derive `intake` (CI-gap intake marker) and is not carried.
 *
 * @param {object} raw
 * @returns {{ number: number, title: string, url: string, labels: string[], intake: boolean }|null}
 */
function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const number = typeof raw.number === 'number' ? raw.number : null;
  if (number === null) return null;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const url = typeof raw.url === 'string' ? raw.url : '';
  const intake =
    typeof raw.body === 'string' && raw.body.includes(CI_GAP_INTAKE_MARKER);
  return { number, title, url, labels: normalizeLabels(raw.labels), intake };
}

/**
 * Accepts `gh` label objects or plain strings.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (l && typeof l === 'object' ? l.name : l))
    .filter((name) => typeof name === 'string');
}

/**
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
    'number,title,labels,url,body',
    '--limit',
    String(limit),
  ];

  const result = await runGh({ ghPath, args, spawnImpl });

  if (
    result.spawnError ||
    (typeof result.code === 'number' && result.code !== 0)
  ) {
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
    const issues = parsed.map(normalizeIssue).filter((issue) => issue !== null);
    return { issues, error: null };
  } catch (err) {
    return {
      issues: [],
      error: `Failed to parse gh issue list JSON for label "${label}": ${err.message}`,
    };
  }
}

/**
 * `seen` spans all buckets so a multi-labelled issue lands once, in the
 * first bucket to claim it.
 *
 * @param {object[]} bucket
 * @param {object[]} issues
 * @param {Set<number>} seen
 * @returns {void}
 */
function dedupeInto(bucket, issues, seen) {
  for (const issue of issues) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    bucket.push(issue);
  }
}

/**
 * One array per ownership bucket (framework, consumer, platform); an issue
 * with several meta labels appears once, in that precedence order.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} [opts.ghPath="gh"]
 * @param {number} [opts.limit=50] — per label.
 * @param {Function} [opts.spawnImpl]
 * @returns {Promise<{
 *   frameworkGaps: object[],
 *   consumerImprovements: object[],
 *   platformGaps: object[],
 *   recurringDefectClasses: Array<{ class: string, count: number, issues: number[] }>,
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
    platformGaps: [],
    recurringDefectClasses: [],
    fetchedAt: new Date().toISOString(),
    errors,
  };

  if (errors.length > 0) return envelope;

  const [gapsResult, improvementsResult, platformResult] = await Promise.all([
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
    fetchByLabel({
      owner,
      repo,
      label: META_LABELS.PLATFORM_GAP,
      ghPath,
      limit,
      spawnImpl,
    }),
  ]);

  for (const { error } of [gapsResult, improvementsResult, platformResult]) {
    if (error) errors.push(error);
  }

  const seen = new Set();
  dedupeInto(envelope.frameworkGaps, gapsResult.issues, seen);
  dedupeInto(envelope.consumerImprovements, improvementsResult.issues, seen);
  dedupeInto(envelope.platformGaps, platformResult.issues, seen);

  envelope.recurringDefectClasses = extractRecurringDefectClasses([
    ...envelope.frameworkGaps,
    ...envelope.consumerImprovements,
    ...envelope.platformGaps,
  ]);

  return envelope;
}
