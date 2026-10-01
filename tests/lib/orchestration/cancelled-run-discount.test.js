// tests/lib/orchestration/cancelled-run-discount.test.js
/**
 * Unit tests for the cancelled-run discount (Story #5534): a red required
 * check from a concurrency-cancelled run is re-read from the newest live run
 * of the same workflow on the same head SHA, and every read fails closed.
 * The `gh api` port is injected — no test touches the network.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCancelledRunDiscount } from '../../../.agents/scripts/lib/orchestration/cancelled-run-discount.js';

const SHA = 'abc123';
const RUN_LINK = 'https://github.com/o/r/actions/runs/100/job/9';

function redEntry(link = RUN_LINK) {
  return { name: 'ci-required', state: 'FAILURE', bucket: 'fail', link };
}

/** Fake `gh api` answering by endpoint; records every call. */
function fakeApi(routes) {
  const calls = [];
  const fn = async (endpoint) => {
    calls.push(endpoint);
    const route = routes[endpoint];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route();
    if (route === undefined) throw new Error(`unexpected ${endpoint}`);
    return route;
  };
  return { fn, calls };
}

const RUN_URL = 'repos/o/r/actions/runs/100';
const SIBLINGS_URL = `repos/o/r/actions/workflows/7/runs?head_sha=${SHA}`;
const cancelledRun = { conclusion: 'cancelled', head_sha: SHA, workflow_id: 7 };

function siblings(...live) {
  return {
    workflow_runs: [
      { id: 100, status: 'completed', conclusion: 'cancelled' },
      ...live,
    ],
  };
}

function discountWith(routes, logger = {}) {
  const api = fakeApi(routes);
  return {
    api,
    discount: createCancelledRunDiscount({
      repo: 'o/r',
      ghApiFn: api.fn,
      logger,
    }),
  };
}

/** Discount one red entry whose run 100 was cancelled, against `body`. */
async function discountAgainst(body) {
  const { discount } = discountWith({
    [RUN_URL]: cancelledRun,
    [SIBLINGS_URL]: body,
  });
  return (await discount([redEntry()], { 'ci-required': 'failure' }))[
    'ci-required'
  ];
}

describe('live sibling selection', () => {
  it('ignores the cancelled run and keeps the highest id, not the latest start', async () => {
    const outcome = await discountAgainst({
      workflow_runs: [
        { id: 100, status: 'completed', conclusion: 'cancelled' },
        { id: 101, status: 'queued', run_started_at: '2026-01-01T00:00:00Z' },
        {
          id: 99,
          status: 'completed',
          conclusion: 'success',
          run_started_at: '2026-02-01T00:00:00Z',
        },
      ],
    });
    assert.equal(outcome, 'pending');
  });

  it('leaves the red with no sibling or a malformed run list', async () => {
    assert.equal(await discountAgainst(siblings()), 'failure');
    assert.equal(await discountAgainst({ workflow_runs: 'x' }), 'failure');
    assert.equal(
      await discountAgainst({ workflow_runs: [{ id: 'x', status: 'queued' }] }),
      'failure',
    );
  });

  it('maps in-flight → pending, success → success, anything else → failure', async () => {
    for (const [status, conclusion, want] of [
      ['in_progress', null, 'pending'],
      ['queued', null, 'pending'],
      ['completed', 'success', 'success'],
      ['completed', 'failure', 'failure'],
      ['completed', 'skipped', 'failure'],
    ]) {
      assert.equal(
        await discountAgainst(siblings({ id: 101, status, conclusion })),
        want,
      );
    }
  });
});

describe('createCancelledRunDiscount', () => {
  it('turns the red into pending while the live sibling is in flight, and logs once per discount', async () => {
    const lines = [];
    const { discount } = discountWith(
      {
        [RUN_URL]: cancelledRun,
        [SIBLINGS_URL]: siblings({
          id: 101,
          status: 'in_progress',
          conclusion: null,
        }),
      },
      { info: (m) => lines.push(m) },
    );
    const out = await discount([redEntry()], { 'ci-required': 'failure' });
    assert.deepEqual(out, { 'ci-required': 'pending' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"ci-required".*cancelled run 100.*live run 101/);
  });

  it('reports the live run verdict once it completes (AC-2)', async () => {
    const green = discountWith({
      [RUN_URL]: cancelledRun,
      [SIBLINGS_URL]: siblings({
        id: 101,
        status: 'completed',
        conclusion: 'success',
      }),
    });
    assert.deepEqual(
      await green.discount([redEntry()], { 'ci-required': 'failure' }),
      { 'ci-required': 'success' },
    );
    const red = discountWith({
      [RUN_URL]: cancelledRun,
      [SIBLINGS_URL]: siblings({
        id: 101,
        status: 'completed',
        conclusion: 'failure',
      }),
    });
    assert.deepEqual(
      await red.discount([redEntry()], { 'ci-required': 'failure' }),
      { 'ci-required': 'failure' },
    );
  });

  it('leaves a red from a run that was not cancelled exactly as it is (AC-3)', async () => {
    const { discount, api } = discountWith({
      [RUN_URL]: { conclusion: 'failure', head_sha: SHA, workflow_id: 7 },
    });
    const out = await discount([redEntry()], { 'ci-required': 'failure' });
    assert.deepEqual(out, { 'ci-required': 'failure' });
    assert.deepEqual(api.calls, [RUN_URL], 'no sibling read for a live red');
  });

  it('leaves a cancelled run with no sibling red (AC-3)', async () => {
    const { discount } = discountWith({
      [RUN_URL]: cancelledRun,
      [SIBLINGS_URL]: siblings(),
    });
    assert.deepEqual(
      await discount([redEntry()], { 'ci-required': 'failure' }),
      { 'ci-required': 'failure' },
    );
  });

  it('fails closed when either gh api read throws or is unparseable (AC-3)', async () => {
    for (const routes of [
      { [RUN_URL]: new Error('HTTP 502') },
      { [RUN_URL]: () => 'not an object' },
      { [RUN_URL]: { conclusion: 'cancelled', head_sha: '', workflow_id: 7 } },
      { [RUN_URL]: cancelledRun, [SIBLINGS_URL]: new Error('rate limited') },
      { [RUN_URL]: cancelledRun, [SIBLINGS_URL]: () => null },
    ]) {
      const { discount } = discountWith(routes);
      assert.deepEqual(
        await discount([redEntry()], { 'ci-required': 'failure' }),
        { 'ci-required': 'failure' },
      );
    }
  });

  it('leaves a red with no Actions run id (a status context) without calling gh', async () => {
    const { discount, api } = discountWith({});
    const out = await discount([redEntry('https://ci.example.com/build/5')], {
      'ci-required': 'failure',
    });
    assert.deepEqual(out, { 'ci-required': 'failure' });
    assert.equal(api.calls.length, 0);
  });

  it('makes no gh api call when nothing is red', async () => {
    const { discount, api } = discountWith({});
    const outcomes = { lint: 'success', test: 'pending' };
    assert.equal(await discount([], outcomes), outcomes);
    assert.equal(api.calls.length, 0);
  });

  it('caches the cancelled-run read per run id but re-reads the siblings each call', async () => {
    let siblingReads = 0;
    const { discount, api } = discountWith({
      [RUN_URL]: cancelledRun,
      [SIBLINGS_URL]: () => {
        siblingReads += 1;
        return siblings({ id: 101, status: 'queued', conclusion: null });
      },
    });
    await discount([redEntry()], { 'ci-required': 'failure' });
    await discount([redEntry()], { 'ci-required': 'failure' });
    assert.equal(api.calls.filter((c) => c === RUN_URL).length, 1);
    assert.equal(siblingReads, 2);
  });

  it('discounts the entry reduceOutcomes kept — the last one for a repeated name', async () => {
    const { discount } = discountWith({
      [RUN_URL]: cancelledRun,
      [SIBLINGS_URL]: siblings({ id: 101, status: 'queued', conclusion: null }),
    });
    const out = await discount(
      [redEntry('https://ci.example.com/x'), redEntry()],
      { 'ci-required': 'failure' },
    );
    assert.deepEqual(out, { 'ci-required': 'pending' });
  });

  it("uses gh's {owner}/{repo} placeholder when no repo is set", async () => {
    const calls = [];
    const discount = createCancelledRunDiscount({
      ghApiFn: async (endpoint) => {
        calls.push(endpoint);
        throw new Error('stop');
      },
    });
    await discount([redEntry()], { 'ci-required': 'failure' });
    assert.deepEqual(calls, ['repos/{owner}/{repo}/actions/runs/100']);
  });
});
