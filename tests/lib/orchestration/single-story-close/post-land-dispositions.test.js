/**
 * The post-land tail records review dispositions before the temp purge reaps
 * the review history, once per Story, and a failure degrades only its own
 * step.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';

import { appendReviewRun } from '../../../../.agents/scripts/lib/orchestration/review-history.js';
import { runPostLandTail } from '../../../../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';
import { makeTempDir } from '../../../../.agents/scripts/lib/test-temp.js';

let tmpDir;
let config;
let ledger;
beforeEach(() => {
  tmpDir = makeTempDir('post-land-dispositions-');
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  const tempRoot = path.join(tmpDir, 'temp');
  config = { project: { paths: { tempRoot } } };
  ledger = path.join(tempRoot, 'review-dispositions.ndjson');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runTail(overrides = {}) {
  return runPostLandTail({
    storyId: 41,
    storyBranch: 'story-41',
    baseBranch: 'main',
    cwd: tmpDir,
    provider: {},
    config,
    emitCloseRecoveredFrictionFn: async () => true,
    emitRecoveredFrictionMarkerFn: async () => true,
    captureStoryFollowUpsFn: async () => ({ ok: true }),
    reassertStatusColumnFn: async () => ({ status: 'synced' }),
    gitSpawnFn: () => ({ status: 0 }),
    planFastForwardFn: () => ({
      runnable: false,
      reason: 'already-up-to-date',
    }),
    executeFastForwardFn: () => ({ applied: true, behind: 0 }),
    acquireLockWithWaitFn: async () => ({ acquired: true, release: () => {} }),
    reapPlanRunLabelsForStoryFn: async () => ({ deleted: [], failed: [] }),
    rollUpEpicForStoryFn: async () => ({ closed: [], epics: [] }),
    reapWorktreePhaseFn: async () => ({ skipped: true, reason: 'none' }),
    releaseStoryLeaseFn: async () => ({ released: true }),
    purgeStoryTempArtifactsFn: async () => ({ errors: [] }),
    ...overrides,
  });
}

const lines = () => fs.readFileSync(ledger, 'utf8').trim().split('\n');

it('records every finding before the purge, and a re-run appends nothing', async () => {
  appendReviewRun(
    41,
    {
      headSha: 'a',
      findings: [
        { severity: 'high', class: 'a', file: 'x.js', provider: 'native' },
        { severity: 'critical', class: 'b', file: 'y.js', provider: 'native' },
      ],
    },
    { config },
  );
  appendReviewRun(
    41,
    {
      headSha: 'b',
      findings: [
        { severity: 'high', class: 'a', file: 'x.js', provider: 'native' },
      ],
    },
    { config },
  );
  let ledgerAtPurge = null;
  const tail = await runTail({
    purgeStoryTempArtifactsFn: async () => {
      ledgerAtPurge = fs.existsSync(ledger) ? lines().length : 0;
      return { errors: [] };
    },
  });
  assert.equal(tail.reviewDispositions, true);
  assert.equal(ledgerAtPurge, 2);
  assert.deepEqual(
    lines()
      .map((l) => JSON.parse(l).disposition)
      .sort(),
    ['fixed-on-branch', 'open-at-merge'],
  );
  const again = await runTail();
  assert.equal(again.reviewDispositions, true);
  assert.equal(again.details.reviewDispositions, 'already recorded');
  assert.equal(lines().length, 2);
});

it('a ledger write failure degrades only its own step', async () => {
  const tail = await runTail({
    recordStoryDispositionsFn: async () => {
      throw new Error('EACCES: ledger not writable');
    },
  });
  assert.equal(tail.reviewDispositions, false);
  assert.match(tail.details.reviewDispositions, /EACCES/);
  for (const key of [
    'followUps',
    'statusResync',
    'worktreeReap',
    'refCleanup',
    'baseFastForward',
    'tempPurge',
    'leaseRelease',
    'epicRollup',
  ]) {
    assert.equal(tail[key], true, key);
  }
});
