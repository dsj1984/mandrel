#!/usr/bin/env node

/**
 * story-review-compute.js — compute the Story-scope review on the worker, at
 * push time, and deposit it for close to adopt.
 *
 * Runs close's compute step (`computeStoryScopeReview` over the configured
 * provider chain, posting nothing) against `origin/<base>...story-<id>` and
 * writes one held-review JSON beside the terminal envelope, keyed on the diff
 * digest. Close adopts it when the digest still matches, so the serialized
 * close tail only posts; a CRITICAL surfaces here, where the worker can fix
 * and re-push inside its own parallel loop.
 *
 * Posts nothing to GitHub and takes no full-suite lock. Exit 0 whatever the
 * findings; 1 only on a usage error or a provider throw.
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { getStoryBranch, gitSpawn } from './lib/git-utils.js';
import { runCodeReview } from './lib/orchestration/code-review.js';
import { resolveSharedBaseRef } from './lib/orchestration/review-base-ref.js';
import {
  buildReviewDeposit,
  computeReviewDiffDigest,
  resolveRefSha,
  writeReviewDeposit,
} from './lib/orchestration/review-deposit.js';
import { computeStoryScopeReview } from './lib/orchestration/single-story-close/phases/code-review.js';

const USAGE = {
  invocation:
    'node .agents/scripts/story-review-compute.js --story <id> [--cwd <workCwd>]',
  summary:
    'Compute the Story-scope code review of origin/<base>...story-<id> without posting it, and write the held result (keyed on the diff digest) for close to adopt. Exits 0 whatever the findings.',
  flags: [
    ['--story <id>', 'Story issue number; the head ref is story-<id>.'],
    [
      '--cwd <path>',
      'Checkout to resolve the branch and diff in (default: the current directory).',
    ],
  ],
};

/**
 * @param {string[]} argv
 * @returns {{ storyId: number|null, cwd: string|null }}
 */
export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    cwd: values.cwd ?? null,
  };
}

/**
 * @param {object} severity
 * @returns {string}
 */
function formatTally(severity) {
  const s = severity ?? {};
  return `critical=${s.critical ?? 0} high=${s.high ?? 0} medium=${s.medium ?? 0} suggestion=${s.suggestion ?? 0}`;
}

/**
 * @param {{ storyId: number, cwd: string, config: object }} input
 * @param {{
 *   gitSpawnFn?: typeof gitSpawn,
 *   runCodeReviewFn?: typeof runCodeReview,
 *   writeDepositFn?: typeof writeReviewDeposit,
 *   progress?: (tag: string, msg: string) => void,
 *   nowIso?: () => string,
 * }} [deps]
 * @returns {Promise<{ written: boolean, path?: string, reason?: string,
 *   deposit?: object }>}
 */
export async function computeStoryReviewDeposit(
  { storyId, cwd, config },
  deps = {},
) {
  const {
    gitSpawnFn = gitSpawn,
    runCodeReviewFn = runCodeReview,
    writeDepositFn = writeReviewDeposit,
    progress = () => {},
    nowIso = () => new Date().toISOString(),
  } = deps;
  const storyBranch = getStoryBranch(storyId);
  const baseBranch = config?.project?.baseBranch ?? 'main';
  const headSha = resolveRefSha({ cwd, ref: storyBranch, gitSpawnFn });
  if (!headSha) {
    return { written: false, reason: `could not resolve ${storyBranch}` };
  }
  const base = resolveSharedBaseRef({ baseBranch, cwd, gitSpawnFn });
  const diffDigest = computeReviewDiffDigest({
    cwd,
    baseRef: base.resolved ? base.ref : null,
    headRef: headSha,
    gitSpawnFn,
  });
  if (!diffDigest) {
    return {
      written: false,
      reason: `could not read the ${base.remoteRef ?? baseBranch}...${storyBranch} diff`,
    };
  }
  const computed = await computeStoryScopeReview({
    cwd,
    storyId,
    headRef: headSha,
    baseBranch,
    deferPost: true,
    provider: null,
    runCodeReviewFn,
    gitSpawnFn,
    progress,
  });
  if (!computed.result) {
    return { written: false, reason: 'the review base is unresolvable' };
  }
  const deposit = buildReviewDeposit({
    storyId,
    headSha,
    baseRef: base.ref,
    diffDigest,
    result: computed.result,
    createdAt: nowIso(),
  });
  const path = writeDepositFn(deposit, { config });
  return { written: true, path, deposit };
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   stdout?: { write: (s: string) => void },
 *   cwd?: string,
 * } & Parameters<typeof computeStoryReviewDeposit>[1]} [deps]
 * @returns {Promise<object>} the outcome
 */
export async function runStoryReviewComputeCli(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    stdout = process.stdout,
    cwd: defaultCwd = process.cwd(),
    ...computeDeps
  } = deps;
  const { storyId, cwd } = parseArgv(argv);
  if (!storyId) {
    throw new Error(
      'story-review-compute: --story <id> is required (a positive integer).',
    );
  }
  const workCwd = cwd ?? defaultCwd;
  const config = resolveConfigImpl({ cwd: workCwd });
  const progress =
    computeDeps.progress ??
    ((tag, msg) => stdout.write(`[story-review-compute] [${tag}] ${msg}\n`));
  const outcome = await computeStoryReviewDeposit(
    { storyId, cwd: workCwd, config },
    { ...computeDeps, progress },
  );
  if (!outcome.written) {
    stdout.write(
      `[story-review-compute] ⏭ No held review written: ${outcome.reason}. Close computes the review itself.\n`,
    );
    return outcome;
  }
  const { deposit } = outcome;
  stdout.write(
    `[story-review-compute] ✅ Held review for Story #${storyId} written → ${outcome.path}\n` +
      `[story-review-compute] diff ${deposit.diffDigest.slice(0, 12)} @ ${deposit.headSha.slice(0, 12)} · ${formatTally(deposit.severity)}\n`,
  );
  if (deposit.halted) {
    stdout.write(
      `[story-review-compute] ❌ CRITICAL: fix, commit and re-push before hand-off. Report:\n${deposit.report}\n`,
    );
  }
  return outcome;
}

async function main() {
  await runStoryReviewComputeCli();
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'story-review-compute',
  propagateExitCode: true,
  errorPrefix: '[story-review-compute] ❌ Fatal error',
  usage: USAGE,
});
