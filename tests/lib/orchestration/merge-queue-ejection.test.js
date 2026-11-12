/**
 * tests/lib/orchestration/merge-queue-ejection.test.js
 *
 * `readQueueEjection` reads the PR's last queue event and the `merge_group`
 * runs of its queue entries, then classifies the ejection as inherited (the
 * entry it was built on failed, or the run was cancelled), own, or unknown.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { readQueueEjection } from '../../../.agents/scripts/lib/orchestration/merge-queue.js';

const HEAD = 'head-sha-1';
const PARENT = 'parent-sha-9';
const PUSHED = '2026-11-11T10:00:00Z';

function removedEvent(overrides = {}) {
  return {
    __typename: 'RemovedFromMergeQueueEvent',
    createdAt: '2026-11-11T11:00:00Z',
    reason: 'FAILED_CHECKS',
    beforeCommit: { oid: HEAD },
    ...overrides,
  };
}

function queueRun(overrides = {}) {
  return {
    id: 501,
    name: 'CI',
    head_branch: `gh-readonly-queue/main/pr-42-${PARENT}`,
    head_sha: 'group-sha-1',
    status: 'completed',
    conclusion: 'failure',
    created_at: '2026-11-11T10:30:00Z',
    html_url: 'https://github.com/o/r/actions/runs/501',
    ...overrides,
  };
}

/** A `gh` facade answering the ejection read's three endpoints. */
function fakeGh({
  event = removedEvent(),
  runs = [queueRun()],
  parentRuns = [],
  jobs = [{ name: 'test', conclusion: 'failure' }],
  labels = [],
  failGraphql = false,
} = {}) {
  const calls = [];
  return {
    calls,
    pr: { view: async () => ({ id: 'PR_node' }) },
    api: async ({ endpoint }) => {
      calls.push(endpoint);
      if (endpoint === 'graphql') {
        if (failGraphql) throw new Error('HTTP 502');
        return JSON.stringify({
          data: {
            node: {
              baseRefName: 'main',
              labels: { nodes: labels.map((name) => ({ name })) },
              timelineItems: { nodes: event ? [event] : [] },
              commits: { nodes: [{ commit: { committedDate: PUSHED } }] },
            },
          },
        });
      }
      if (endpoint.includes('/jobs')) return JSON.stringify({ jobs });
      if (endpoint.includes('head_sha=')) {
        return JSON.stringify({ workflow_runs: parentRuns });
      }
      return JSON.stringify({ workflow_runs: runs });
    },
  };
}

const read = (gh) =>
  readQueueEjection({ prNodeId: 'PR_node', prNumber: 42, headSha: HEAD, gh });

describe('readQueueEjection', () => {
  it('is inherited when the run of the entry it was built on failed', async () => {
    const gh = fakeGh({
      parentRuns: [
        queueRun({ id: 400, head_sha: PARENT, conclusion: 'failure' }),
      ],
    });
    const out = await read(gh);
    assert.equal(out.verdict, 'inherited');
    assert.equal(out.run.id, 501);
    assert.ok(gh.calls.some((c) => c.includes(`head_sha=${PARENT}`)));
  });

  it('is inherited when the ejecting run was cancelled', async () => {
    const out = await read(
      fakeGh({ runs: [queueRun({ conclusion: 'cancelled' })] }),
    );
    assert.equal(out.verdict, 'inherited');
  });

  it('is own when the entry ahead passed, naming the failed jobs', async () => {
    const out = await read(
      fakeGh({
        parentRuns: [queueRun({ head_sha: PARENT, conclusion: 'success' })],
        jobs: [
          { name: 'lint', conclusion: 'success' },
          { name: 'test (ubuntu)', conclusion: 'failure' },
        ],
      }),
    );
    assert.equal(out.verdict, 'own');
    assert.deepEqual(out.failedJobs, ['test (ubuntu)']);
    assert.equal(out.run.url, 'https://github.com/o/r/actions/runs/501');
  });

  it('is own when the group was built directly on the base tip', async () => {
    const out = await read(fakeGh({ parentRuns: [] }));
    assert.equal(out.verdict, 'own');
  });

  it('settles as own past three inherited entries on one head', async () => {
    const runs = [1, 2, 3, 4].map((n) =>
      queueRun({
        id: 500 + n,
        head_sha: `group-${n}`,
        conclusion: 'cancelled',
        created_at: `2026-11-11T10:0${n}:00Z`,
      }),
    );
    const out = await read(fakeGh({ runs }));
    assert.equal(out.verdict, 'own');
    assert.equal(out.run.id, 504, 'the newest entry ejected it');
  });

  it('ignores queue runs of other PRs and of an older head', async () => {
    const out = await read(
      fakeGh({
        runs: [
          queueRun({ head_branch: `gh-readonly-queue/main/pr-421-${PARENT}` }),
          queueRun({ created_at: '2026-11-11T09:00:00Z' }),
        ],
      }),
    );
    assert.equal(out.verdict, 'unknown');
  });

  it('is unknown while no queue run of the entry has completed', async () => {
    const out = await read(
      fakeGh({ runs: [queueRun({ status: 'in_progress', conclusion: null })] }),
    );
    assert.equal(out.verdict, 'unknown');
  });

  it('is unknown, never a throw, when a read fails', async () => {
    const out = await read(fakeGh({ failGraphql: true }));
    assert.equal(out.verdict, 'unknown');
    assert.match(out.detail, /502/);
  });

  it('is no ejection for a merge, an enqueue, or a removal of another head', async () => {
    for (const event of [
      removedEvent({ reason: 'MERGED' }),
      { __typename: 'AddedToMergeQueueEvent' },
      removedEvent({ beforeCommit: { oid: 'older-head' } }),
      removedEvent({ beforeCommit: null, createdAt: '2026-11-11T09:00:00Z' }),
      null,
    ]) {
      const out = await read(fakeGh({ event, labels: ['release-hold'] }));
      assert.equal(out.verdict, null, JSON.stringify(event));
      assert.deepEqual(out.labels, ['release-hold']);
    }
  });
});
