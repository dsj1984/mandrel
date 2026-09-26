/**
 * review-deposit.js — the held Story-scope review a worker computes at push
 * time, and its identity.
 *
 * The identity is the **diff digest**: a sha256 of the exact
 * `git diff --no-color <base>...<head>` text the review provider is handed.
 * A clean base-sync merge moves HEAD without changing that text, while any
 * commit that changes the diff changes it — so close adopts a deposit, and
 * posts a held result, on digest equality, never on SHA equality.
 *
 * The file lives beside the terminal envelope; nothing deletes it but the
 * Story temp purge. A mismatched deposit is simply not adopted.
 */

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';

import { storyReviewDepositPath } from '../config/temp-paths.js';

const DEPOSIT_KIND = 'story-review-deposit';

/**
 * @param {{ cwd: string, ref: string, gitSpawnFn: Function }} args
 * @returns {string|null} the commit `ref` points at.
 */
export function resolveRefSha({ cwd, ref, gitSpawnFn }) {
  try {
    const probe = gitSpawnFn(
      cwd,
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    );
    const sha = probe?.status === 0 ? String(probe.stdout ?? '').trim() : '';
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * sha256 of the three-dot diff text, spawned exactly as the review provider
 * spawns it. `null` when the diff cannot be read — an unknown identity that
 * never matches anything.
 *
 * @param {{ cwd: string, baseRef: string|null, headRef: string|null,
 *   gitSpawnFn: Function }} args
 * @returns {string|null}
 */
export function computeReviewDiffDigest({ cwd, baseRef, headRef, gitSpawnFn }) {
  if (!baseRef || !headRef) return null;
  try {
    const diff = gitSpawnFn(
      cwd,
      'diff',
      '--no-color',
      `${baseRef}...${headRef}`,
    );
    if (diff?.status !== 0) return null;
    return createHash('sha256')
      .update(String(diff.stdout ?? ''), 'utf8')
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * Flatten a computed review `result` into the deposit record.
 *
 * @param {{ storyId: number, headSha: string, baseRef: string,
 *   diffDigest: string, result: object, createdAt?: string }} args
 * @returns {object}
 */
export function buildReviewDeposit({
  storyId,
  headSha,
  baseRef,
  diffDigest,
  result,
  createdAt = new Date().toISOString(),
}) {
  return {
    kind: DEPOSIT_KIND,
    storyId,
    headSha,
    baseRef,
    diffDigest,
    createdAt,
    provider: result.providerName ?? null,
    severity: result.severity,
    halted: !!result.halted,
    criticalByProvider: result.criticalByProvider ?? {},
    findings: Array.isArray(result.findings) ? result.findings : [],
    report: result.report ?? '',
    degraded: !!result.degraded,
    degradations: Array.isArray(result.degradations) ? result.degradations : [],
    blockerReason: result.blockerReason ?? null,
  };
}

/**
 * The deposit as `computeStoryScopeReview`'s `{ result }` shape, ready for
 * `settleStoryScopeReview` to post.
 *
 * @param {object} deposit
 * @returns {{ result: object }}
 */
export function depositAsComputedReview(deposit) {
  return {
    result: {
      status: 'ok',
      severity: deposit.severity,
      findings: deposit.findings,
      providerName: deposit.provider,
      report: deposit.report,
      posted: false,
      postedCommentId: null,
      halted: deposit.halted,
      criticalByProvider: deposit.criticalByProvider,
      degraded: deposit.degraded,
      degradations: deposit.degradations,
      blockerReason: deposit.blockerReason,
    },
  };
}

/**
 * Atomic write (pid-scoped tmp + rename): close may read it mid-write.
 *
 * @param {object} deposit
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 * @returns {string} the path written.
 */
export function writeReviewDeposit(deposit, { config, fsImpl = nodeFs } = {}) {
  const target = storyReviewDepositPath(deposit.storyId, config);
  fsImpl.mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.tmp`;
  fsImpl.writeFileSync(
    tmpPath,
    `${JSON.stringify(deposit, null, 2)}\n`,
    'utf8',
  );
  fsImpl.renameSync(tmpPath, target);
  return target;
}

/**
 * @param {unknown} record
 * @param {number} storyId
 * @returns {boolean}
 */
function isDeposit(record, storyId) {
  return (
    record?.kind === DEPOSIT_KIND &&
    record.storyId === storyId &&
    typeof record.diffDigest === 'string' &&
    record.diffDigest.length > 0 &&
    typeof record.report === 'string' &&
    typeof record.severity === 'object' &&
    record.severity !== null
  );
}

/**
 * @param {number} storyId
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 * @returns {object|null} the Story's deposit, or `null` when absent or
 *   malformed.
 */
export function readReviewDeposit(storyId, { config, fsImpl = nodeFs } = {}) {
  try {
    const raw = fsImpl.readFileSync(
      storyReviewDepositPath(storyId, config),
      'utf8',
    );
    const record = JSON.parse(raw);
    return isDeposit(record, storyId) ? record : null;
  } catch {
    return null;
  }
}
