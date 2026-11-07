/**
 * review-deposit.js — the held Story-scope review a worker computes at push
 * time, and its identity.
 *
 * The identity is the **diff digest**: a sha256 of the
 * `git diff --no-color <base>...<head>` text, less generated files, `index`
 * lines and hunk-header offsets (`git patch-id --stable`'s sameness). A
 * base-sync merge that only moves merge-base blobs or line positions keeps
 * it; any changed `+`, `-` or context line moves it — so close adopts a
 * deposit, and posts a held result, on digest equality, never on SHA equality.
 *
 * The file lives beside the terminal envelope; nothing deletes it but the
 * Story temp purge. A mismatched deposit is simply not adopted.
 */

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';

import { storyReviewDepositPath } from '../config/temp-paths.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { resolveSharedBaseRef } from './review-base-ref.js';
import {
  diffSections,
  generatedPaths,
  sectionPath,
} from './review-providers/generated-diff.js';

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

/** A section less its `index` lines, each hunk header reduced to `@@`. */
function identityOf(section) {
  return section
    .trimEnd()
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (/^@@ -\d/.test(line) ? '@@' : line))
    .join('\n');
}

/** Generated sections dropped, the rest reduced to their identity. */
function reviewedText(diff, deps) {
  const sections = diffSections(diff);
  const generated = generatedPaths(
    sections.map(sectionPath).filter(Boolean),
    deps,
  );
  return sections
    .filter((s) => !generated.has(sectionPath(s)))
    .map(identityOf)
    .join('\n');
}

/**
 * sha256 of the three-dot diff's identity, spawned exactly as the review
 * provider spawns it (the provider still receives the raw diff). `null` when the diff cannot be read — an unknown identity that
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
    const text = reviewedText(String(diff.stdout ?? ''), { cwd, gitSpawnFn });
    return createHash('sha256').update(text, 'utf8').digest('hex');
  } catch {
    return null;
  }
}

/** A halt recorded before `haltCause` existed was a critical one. */
function haltCauseOf(record) {
  if (!record.halted) return null;
  return record.haltCause === 'no-verdict' ? 'no-verdict' : 'critical';
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
    haltCause: haltCauseOf(result),
    criticalByProvider: result.criticalByProvider ?? {},
    findings: Array.isArray(result.findings) ? result.findings : [],
    report: result.report ?? '',
    degraded: !!result.degraded,
    degradations: Array.isArray(result.degradations) ? result.degradations : [],
    verification: result.verification ?? null,
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
      haltCause: haltCauseOf(deposit),
      criticalByProvider: deposit.criticalByProvider,
      degraded: deposit.degraded,
      degradations: deposit.degradations,
      verification: deposit.verification ?? null,
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
  writeFileAtomic(target, `${JSON.stringify(deposit, null, 2)}\n`, { fsImpl });
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

/**
 * Close's held-review start point: the base ref, the diff digest of
 * `origin/<base>...<sha>`, and the worker deposit when its digest matches.
 *
 * @param {{ cwd: string, storyId: number|string, sha: string,
 *   baseBranch: string, gitSpawnFn: Function, config?: object,
 *   readDepositFn?: typeof readReviewDeposit }} args
 * @returns {{ baseRef: string|null, diffDigest: string|null,
 *   deposit: object|null }}
 */
export function probeHeldReviewDiff({
  cwd,
  storyId,
  sha,
  baseBranch,
  gitSpawnFn,
  config,
  readDepositFn = readReviewDeposit,
}) {
  const base = resolveSharedBaseRef({ baseBranch, cwd, gitSpawnFn });
  const baseRef = base.resolved ? base.ref : null;
  const diffDigest = computeReviewDiffDigest({
    cwd,
    baseRef,
    headRef: sha,
    gitSpawnFn,
  });
  const deposit = diffDigest
    ? readDepositFn(Number(storyId), { config })
    : null;
  const held = adoptable(deposit, diffDigest) ? deposit : null;
  return { baseRef, diffDigest, deposit: held };
}

/** A missing verdict reflects the provider's state, not the diff. */
function adoptable(deposit, diffDigest) {
  return (
    deposit?.diffDigest === diffDigest && deposit.haltCause !== 'no-verdict'
  );
}
