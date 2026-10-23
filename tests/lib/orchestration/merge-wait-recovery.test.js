/**
 * tests/lib/orchestration/merge-wait-recovery.test.js
 *
 * `maybeRearmPr` re-arms a close-armed PR disarmed by an advisory red once
 * the probe reads that check green on the same head (`advisory-cleared`),
 * once per head and verdict, never under `autoMerge: 'strict'` and never over
 * a required red (Story #5876).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  maybeRearmPr,
  mergeWaitRecoverySeams,
} from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/merge-wait-recovery.js';

const HEAD = 'abc1234def';

const ADVISORY_DIGEST = {
  headSha: HEAD,
  allFailures: [{ name: 'policy-impact', outcome: 'failure', required: false }],
};

function harness({ digest = ADVISORY_DIGEST, config = {} } = {}) {
  const rearms = [];
  const lines = [];
  const state = { digest };
  const ctx = {
    storyId: 5876,
    prNumber: 42,
    cwd: '/repo',
    config,
    closeArmed: true,
    progress: (_tag, msg) => lines.push(msg),
    ...mergeWaitRecoverySeams({
      readCiDigestFn: () => state.digest,
      rearmAutoMergeFn: async (args) => {
        rearms.push(args);
        return { enabled: true };
      },
    }),
  };
  return { ctx, rearms, lines, state };
}

function unarmedProbe(checkStates) {
  return {
    state: 'OPEN',
    mergedAt: null,
    autoMergeArmed: false,
    checksStatus: 'success',
    headSha: HEAD,
    checkStates,
  };
}

describe('maybeRearmPr — advisory-cleared', () => {
  it('re-arms once the advisory check reads green on the same head, naming it', async () => {
    const h = harness();
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'success' }));
    assert.equal(h.rearms.length, 1);
    assert.equal(h.rearms[0].prNumber, 42);
    assert.match(
      h.lines.find((l) => /re-armed/.test(l)) ?? '',
      /`policy-impact`/,
    );
  });

  it('attempts it once per head and verdict', async () => {
    const h = harness();
    const probe = unarmedProbe({ 'policy-impact': 'success' });
    await maybeRearmPr(h.ctx, probe);
    await maybeRearmPr(h.ctx, probe);
    assert.equal(h.rearms.length, 1);
  });

  it('re-arms after an earlier refusal on the same head once the check greens', async () => {
    const h = harness();
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'pending' }));
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'pending' }));
    assert.equal(h.rearms.length, 0);
    assert.equal(
      h.lines.filter((l) => /not re-armed \(rerun/.test(l)).length,
      1,
      'the refusal is reported once',
    );
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'success' }));
    assert.equal(h.rearms.length, 1);
  });

  it('never re-arms under autoMerge strict', async () => {
    const h = harness({
      config: { delivery: { ci: { autoMerge: 'strict' } } },
    });
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'success' }));
    assert.equal(h.rearms.length, 0);
  });

  it('never re-arms over a required red on the same head', async () => {
    const h = harness({
      digest: {
        headSha: HEAD,
        allFailures: [{ name: 'validate', outcome: 'failure', required: true }],
      },
    });
    await maybeRearmPr(h.ctx, unarmedProbe({ validate: 'success' }));
    assert.equal(h.rearms.length, 0);
  });

  it('never re-arms a PR close did not arm', async () => {
    const h = harness();
    h.ctx.closeArmed = false;
    await maybeRearmPr(h.ctx, unarmedProbe({ 'policy-impact': 'success' }));
    assert.equal(h.rearms.length, 0);
  });
});
