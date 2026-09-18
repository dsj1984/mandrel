/**
 * tests/lib/orchestration/check-state.test.js — Story #5383.
 *
 * The ONE check-state classifier both merge-wait readers share: the merge
 * wait's `statusCheckRollup` reader (`merge-poll.js#deriveChecksStatus`) and
 * the recovery watch's `gh pr checks --required` reader
 * (`pr-watch.js#reduceOutcomes`). The tables below enumerate every state each
 * GitHub source can emit, and pin the pass / fail / pending verdict it maps
 * to — so a new GitHub value, or a drift between the readers, fails here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  checkVerdict,
  classifyRequiredCheck,
  classifyRollupEntry,
  isRerunPermitted,
} from '../../../.agents/scripts/lib/orchestration/check-state.js';
import { classifyGreenVerdict } from '../../../.agents/scripts/lib/orchestration/ci-rerun-guard.js';
import { deriveChecksStatus } from '../../../.agents/scripts/lib/orchestration/merge-poll.js';
import { reduceOutcomes } from '../../../.agents/scripts/lib/orchestration/pr-watch.js';

/**
 * `gh pr checks --required --json name,state,bucket` — the recovery watch's
 * source. `state` is the CheckRun conclusion / status or the StatusContext
 * state; `bucket` is gh's own coarse class.
 */
const REQUIRED_READER_TABLE = [
  // [entry, outcome, verdict]
  [{ state: 'SUCCESS', bucket: 'pass' }, 'success', 'pass'],
  [{ state: 'FAILURE', bucket: 'fail' }, 'failure', 'fail'],
  [{ state: 'STARTUP_FAILURE', bucket: 'fail' }, 'failure', 'fail'],
  [{ state: 'ERROR', bucket: 'fail' }, 'failure', 'fail'],
  [{ state: 'TIMED_OUT', bucket: 'fail' }, 'timed_out', 'fail'],
  [{ state: 'CANCELLED', bucket: 'cancel' }, 'cancelled', 'fail'],
  [{ state: 'ACTION_REQUIRED', bucket: 'fail' }, 'action_required', 'fail'],
  [{ state: 'STALE', bucket: 'fail' }, 'stale', 'fail'],
  [{ state: 'NEUTRAL', bucket: 'pass' }, 'neutral', 'pass'],
  [{ state: 'SKIPPED', bucket: 'skipping' }, 'skipped', 'pass'],
  [{ state: 'PENDING', bucket: 'pending' }, 'pending', 'pending'],
  [{ state: 'QUEUED', bucket: 'pending' }, 'pending', 'pending'],
  [{ state: 'IN_PROGRESS', bucket: 'pending' }, 'pending', 'pending'],
  [{ state: 'REQUESTED', bucket: 'pending' }, 'pending', 'pending'],
  [{ state: 'WAITING', bucket: 'pending' }, 'pending', 'pending'],
  [{ state: 'EXPECTED', bucket: 'pending' }, 'pending', 'pending'],
  // `state` empty → gh's bucket is the fallback.
  [{ state: '', bucket: 'pass' }, 'success', 'pass'],
  [{ state: '', bucket: 'fail' }, 'failure', 'fail'],
  [{ state: '', bucket: 'cancel' }, 'cancelled', 'fail'],
  [{ state: '', bucket: 'skipping' }, 'skipped', 'pass'],
  [{ state: '', bucket: 'pending' }, 'pending', 'pending'],
  [{}, 'pending', 'pending'],
];

/**
 * `gh pr view --json statusCheckRollup` — the merge wait's source. CheckRuns
 * carry `{ status, conclusion }`; legacy StatusContexts carry `{ state }`.
 */
const ROLLUP_READER_TABLE = [
  // CheckRun, completed.
  [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, 'success', 'pass'],
  [{ status: 'COMPLETED', conclusion: 'FAILURE' }, 'failure', 'fail'],
  [{ status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' }, 'failure', 'fail'],
  [{ status: 'COMPLETED', conclusion: 'TIMED_OUT' }, 'timed_out', 'fail'],
  [{ status: 'COMPLETED', conclusion: 'CANCELLED' }, 'cancelled', 'fail'],
  [
    { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    'action_required',
    'fail',
  ],
  [{ status: 'COMPLETED', conclusion: 'STALE' }, 'stale', 'fail'],
  [{ status: 'COMPLETED', conclusion: 'NEUTRAL' }, 'neutral', 'pass'],
  [{ status: 'COMPLETED', conclusion: 'SKIPPED' }, 'skipped', 'pass'],
  [{ status: 'COMPLETED' }, 'success', 'pass'],
  // CheckRun, in flight.
  [{ status: 'QUEUED' }, 'pending', 'pending'],
  [{ status: 'IN_PROGRESS' }, 'pending', 'pending'],
  [{ status: 'WAITING' }, 'pending', 'pending'],
  [{ status: 'REQUESTED' }, 'pending', 'pending'],
  [{ status: 'PENDING' }, 'pending', 'pending'],
  // Legacy StatusContext.
  [{ state: 'SUCCESS' }, 'success', 'pass'],
  [{ state: 'FAILURE' }, 'failure', 'fail'],
  [{ state: 'ERROR' }, 'failure', 'fail'],
  [{ state: 'PENDING' }, 'pending', 'pending'],
  [{ state: 'EXPECTED' }, 'pending', 'pending'],
  [{}, 'pending', 'pending'],
];

describe('classifyRequiredCheck — every `gh pr checks --required` state', () => {
  for (const [entry, outcome, verdict] of REQUIRED_READER_TABLE) {
    it(`${JSON.stringify(entry)} → ${outcome} (${verdict})`, () => {
      assert.equal(classifyRequiredCheck(entry), outcome);
      assert.equal(checkVerdict(classifyRequiredCheck(entry)), verdict);
    });
  }
});

describe('classifyRollupEntry — every `statusCheckRollup` state', () => {
  for (const [entry, outcome, verdict] of ROLLUP_READER_TABLE) {
    it(`${JSON.stringify(entry)} → ${outcome} (${verdict})`, () => {
      assert.equal(classifyRollupEntry(entry), outcome);
      assert.equal(checkVerdict(classifyRollupEntry(entry)), verdict);
    });
  }
});

describe('both readers route through the one classifier', () => {
  it('the --required reader reduces each entry via classifyRequiredCheck', () => {
    const entries = REQUIRED_READER_TABLE.map(([entry], i) => ({
      name: `check-${i}`,
      ...entry,
    }));
    const outcomes = reduceOutcomes(entries);
    for (const [i, [, outcome]] of REQUIRED_READER_TABLE.entries()) {
      assert.equal(outcomes[`check-${i}`], outcome);
    }
  });

  it('the rollup reader aggregates each entry by its checkVerdict', () => {
    const expectedAggregate = {
      pass: 'success',
      fail: 'failure',
      pending: 'still-running',
    };
    for (const [entry, , verdict] of ROLLUP_READER_TABLE) {
      assert.equal(
        deriveChecksStatus([entry]),
        expectedAggregate[verdict],
        JSON.stringify(entry),
      );
    }
  });

  it('agrees across sources on the same GitHub state', () => {
    // The drift this module exists to stop: a legacy `ERROR` context read
    // green by one reader and red by the other.
    for (const raw of ['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED']) {
      assert.equal(
        classifyRequiredCheck({ state: raw }),
        classifyRollupEntry({ state: raw }),
        raw,
      );
    }
  });
});

describe('the shared classifier — edge cases, through both adapters', () => {
  it('is case- and whitespace-insensitive, and nullish is pending', () => {
    assert.equal(classifyRequiredCheck({ state: '  success ' }), 'success');
    assert.equal(classifyRollupEntry({ state: '  success ' }), 'success');
    assert.equal(classifyRequiredCheck(undefined), 'pending');
    assert.equal(classifyRollupEntry(undefined), 'pending');
    assert.equal(classifyRollupEntry({ state: null }), 'pending');
  });

  it('maps an unenumerated value to skipped — never a prototype member', () => {
    for (const raw of ['weird', 'constructor', '__proto__']) {
      assert.equal(classifyRequiredCheck({ state: raw }), 'skipped', raw);
      assert.equal(classifyRollupEntry({ state: raw }), 'skipped', raw);
    }
  });
});

describe('isRerunPermitted — the rerun policy, stated once', () => {
  it('never permits rerunning a required red without a recorded allowance', () => {
    assert.equal(isRerunPermitted({ required: true }), false);
    assert.equal(
      isRerunPermitted({ required: true, allowanceRecorded: false }),
      false,
    );
  });

  it('admits the one evidence-gated allowance on a required red (Story #5343)', () => {
    assert.equal(
      isRerunPermitted({ required: true, allowanceRecorded: true }),
      true,
    );
  });

  it('permits rerunning an advisory red', () => {
    assert.equal(isRerunPermitted({ required: false }), true);
  });

  it('treats unknown required-ness as required (fails closed)', () => {
    assert.equal(isRerunPermitted({}), false);
    assert.equal(isRerunPermitted(), false);
  });

  it('is the rule the recovery watch adjudicates a same-SHA green by', () => {
    // The watch reads `--required` checks, so its recorded red is a required
    // red: a same-SHA green is a forbidden rerun unless an allowance for that
    // head was recorded — exactly isRerunPermitted({ required: true, … }).
    const noAllowance = classifyGreenVerdict({
      digest: { headSha: 'abc' },
      headSha: 'abc',
    });
    assert.equal(noAllowance.verdict, 'rerun');
    assert.equal(isRerunPermitted({ required: true }), false);

    const withAllowance = classifyGreenVerdict({
      digest: {
        headSha: 'abc',
        rerunAllowance: { verdict: 'capacity', headSha: 'abc' },
      },
      headSha: 'abc',
    });
    assert.equal(withAllowance.verdict, 'rerun-permitted');
    assert.equal(
      isRerunPermitted({ required: true, allowanceRecorded: true }),
      true,
    );
  });
});
