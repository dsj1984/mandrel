/**
 * prior-feedback-fetcher.js — gh-CLI-backed fetcher for open meta feedback
 * issues that feed the `/plan` Phase 0 planner context.
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
 *
 * Story #4135 (Epic #4131, F11) — the envelope additionally carries a
 * `recurringDefectClasses[]` array derived from the `friction::<class>`
 * labels the retro routed-proposals composer stamps onto the meta issues it
 * proposes. That closes the retro→planner loop: a recurring defect class
 * caught by review/deliver is filed as a `meta::*` + `friction::<class>`
 * issue, and the next `/plan` Phase 0 surfaces the class (with a recurrence
 * count across the open feedback issues) to the decompose-author guidance so
 * the planning floor ratchets up. The derivation is no-op-safe: issues with
 * no `friction::*` label contribute nothing and the array is empty.
 */

import { META_LABELS } from '../label-constants.js';
import { runChild } from './graduator-core.js';

const DEFAULT_LIMIT = 50;

/** Prefix stamped on routed-proposal issue labels by the retro composer. */
const FRICTION_LABEL_PREFIX = 'friction::';

/**
 * Pure: derive recurring-defect-class signals from a list of normalized
 * issues by counting `friction::<class>` labels across them (Story #4135).
 *
 * Each fetched meta issue may carry one `friction::<class>` label (stamped by
 * the retro routed-proposals composer when it proposed the issue). A class
 * that appears across **multiple** open feedback issues is recurring across
 * Epics — exactly the signal F11 surfaces to the planner. The count is the
 * number of distinct open issues carrying the class; the `issues[]` array
 * lists their numbers so the planner can cross-reference.
 *
 * Determinism: classes are sorted by descending recurrence count, ties
 * broken by class name ASC, so a given input always yields a stable order.
 *
 * No-op-safe: issues without a `friction::*` label contribute nothing; an
 * empty / non-array input yields `[]`.
 *
 * @param {Array<{ number: number, labels?: string[] }>} issues
 * @returns {Array<{ class: string, count: number, issues: number[] }>}
 */
export function extractRecurringDefectClasses(issues) {
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
 * Spawn the given gh CLI with the supplied args and resolve to
 * `{ code, stdout, stderr, spawnError }`. Delegates to the shared
 * `runChild` helper in `graduator-core.js` (Story #3845 folded the three
 * feedback-loop spawn copies into one) — the fetcher only needs JSON-mode
 * reads and structured error capture, which `runChild` provides.
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
function runGh({ ghPath, args, spawnImpl }) {
  return runChild({ cmd: ghPath, args, spawnImpl });
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
    recurringDefectClasses: [],
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

  // Story #4135 (Epic #4131, F11) — close the retro→planner loop: derive the
  // recurring defect classes from the `friction::<class>` labels carried by
  // the deduped feedback issues, so the next /plan Phase 0 surfaces them to
  // the decompose-author guidance. No-op-safe when no issue carries a
  // `friction::*` label (empty array, no behavioural change).
  envelope.recurringDefectClasses = extractRecurringDefectClasses([
    ...envelope.frameworkGaps,
    ...envelope.consumerImprovements,
  ]);

  return envelope;
}

export default fetchPriorFeedback;
