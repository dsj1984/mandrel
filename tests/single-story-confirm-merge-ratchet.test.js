/**
 * Story #5955 — with `coverage.ciRatchetCheck` set, confirm-merge holds the
 * `agent::done` flip on a merged PR carrying the `Coverage-deferred:` key
 * line until the declared check is green on the PR head. Absent or in flight
 * stays pending at `agent::closing`; red flips `agent::blocked` with a
 * friction comment naming the check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ratchetWaitOutcome } from '../.agents/scripts/lib/single-story/ci-ratchet-gate.js';
import { confirmStoryMerged } from '../.agents/scripts/lib/single-story/confirm-merge.js';

const CHECK = 'coverage-ratchet';
const DEFERRED_BODY =
  'Closes #5955\n\nCoverage deferred to CI: CI is the coverage and CRAP ratchet of record (suiteOfRecord: ci).\nCoverage-deferred: suite-of-record-ci\n\n_Auto-opened by `/mandrel-deliver`._';
const config = (ciRatchetCheck) => ({
  delivery: { quality: { gates: { coverage: { ciRatchetCheck } } } },
});

function fakeProvider() {
  let labels = ['agent::closing'];
  const comments = [];
  return {
    getTicket: async () => ({ id: 5955, title: 'Ratchet', labels }),
    getTicketComments: async () => [],
    postComment: async (_id, payload) => {
      comments.push(payload.body);
      return { id: comments.length };
    },
    updateTicket: async (_id, patch) => {
      labels = [
        ...labels.filter((l) => !(patch.labels?.remove ?? []).includes(l)),
        ...(patch.labels?.add ?? []),
      ];
    },
    labels: () => labels,
    comments,
  };
}

async function confirm({ body = DEFERRED_BODY, rollup = [], check = CHECK }) {
  const provider = fakeProvider();
  const views = [];
  const result = await confirmStoryMerged({
    provider,
    storyId: 5955,
    prNumber: 77,
    cwd: '/repo',
    config: config(check),
    injectedNotify: async () => {},
    readPrMergeStateFn: async () => ({ state: 'MERGED', mergedAt: 'now' }),
    injectedGh: {
      pr: {
        view: async (n, fields) => {
          views.push({ n, fields });
          return { body, statusCheckRollup: rollup };
        },
      },
    },
  });
  return { result, provider, views };
}

const run = (fields) => ({ name: CHECK, ...fields });

describe('confirm-merge — the CI ratchet hold (AC-10)', () => {
  it('confirms once the declared check is green on the PR head', async () => {
    const { result, provider } = await confirm({
      rollup: [run({ status: 'COMPLETED', conclusion: 'SUCCESS' })],
    });
    assert.equal(result.action, 'done');
    assert.ok(provider.labels().includes('agent::done'));
  });

  for (const [label, rollup] of [
    ['absent', [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }]],
    ['in flight', [run({ status: 'IN_PROGRESS' })]],
  ]) {
    it(`stays pending at agent::closing while the check is ${label}`, async () => {
      const { result, provider } = await confirm({ rollup });
      assert.equal(result.action, 'pending');
      assert.equal(result.reason, 'ci-ratchet-pending');
      assert.equal(result.merged, false);
      assert.deepEqual(provider.labels(), ['agent::closing']);
    });
  }

  it('blocks on a red check with a friction comment naming it', async () => {
    const { result, provider } = await confirm({
      rollup: [run({ status: 'COMPLETED', conclusion: 'FAILURE' })],
    });
    assert.equal(result.action, 'blocked');
    assert.equal(result.reason, 'ci-ratchet-red');
    assert.ok(provider.labels().includes('agent::blocked'));
    assert.ok(!provider.labels().includes('agent::done'));
    assert.equal(provider.comments.length, 1);
    assert.match(provider.comments[0], /coverage-ratchet/);
    assert.match(provider.comments[0], /PR #77/);
  });

  it('confirms as today without the marker or without ciRatchetCheck', async () => {
    const unmarked = await confirm({ body: 'Closes #5955' });
    assert.equal(unmarked.result.action, 'done');
    const undeclared = await confirm({ check: null });
    assert.equal(undeclared.result.action, 'done');
    assert.equal(undeclared.views.length, 0, 'no PR read without the key');
  });
});

describe('the ratchet verdict', () => {
  it('a green re-run outranks an earlier red', async () => {
    const { result } = await confirm({
      rollup: [
        run({ status: 'COMPLETED', conclusion: 'FAILURE' }),
        run({ status: 'COMPLETED', conclusion: 'SUCCESS' }),
      ],
    });
    assert.equal(result.action, 'done');
  });

  it('reads a status context by its context name', async () => {
    const { result } = await confirm({
      rollup: [{ context: CHECK, state: 'PENDING' }],
    });
    assert.equal(result.reason, 'ci-ratchet-pending');
  });
});

describe('ratchetWaitOutcome', () => {
  it('maps a held confirmation onto close’s merge-wait outcome', () => {
    const wait = { prProbe: { checksStatus: 'success' }, elapsedSeconds: 3 };
    assert.equal(ratchetWaitOutcome({ action: 'done' }, wait), null);
    const pending = ratchetWaitOutcome(
      { action: 'pending', reason: 'ci-ratchet-pending' },
      wait,
    );
    assert.equal(pending.terminal, 'pending');
    assert.equal(pending.prProbe.state, 'MERGED');
    const blocked = ratchetWaitOutcome(
      { action: 'blocked', reason: 'ci-ratchet-red', detail: 'red' },
      wait,
    );
    assert.equal(blocked.terminal, 'blocked');
    assert.equal(blocked.blockClass, 'checks-failed');
  });
});
