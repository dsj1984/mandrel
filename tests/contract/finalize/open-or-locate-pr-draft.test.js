/**
 * tests/contract/finalize/open-or-locate-pr-draft.test.js
 *
 * Contract test for the early-PR draft path — Story #4359 (Epic #4355).
 *
 * Asserts:
 *   1. `openOrLocatePr({ draft: true })` appends `--draft` to the
 *      `gh pr create` shell while preserving the `feat: Epic #<id>` /
 *      `Closes #<id>` title/body contract.
 *   2. `openOrLocatePr()` (no draft — the earlyPr=false close-time path)
 *      does NOT pass `--draft`, so the create shell is byte-identical to
 *      the pre-Story behaviour.
 *   3. Draft mode stays idempotent — a second call on the same head
 *      branch locates the existing PR and never re-creates (draft or not).
 *   4. `markPrReady` shells `gh pr ready <ref>` and returns
 *      `{ pr, ready: true }`; a non-zero exit throws with stderr detail;
 *      an empty reference throws a TypeError.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  markPrReady,
  openOrLocatePr,
} from '../../../.agents/scripts/lib/orchestration/finalize/open-or-locate-pr.js';

/**
 * Tiny scripted gh-spawn that walks through a queue of stubbed responses.
 * Each call shifts one entry; an empty queue is a test bug.
 */
function scriptedGh(queue) {
  const calls = [];
  return {
    spawn: ({ args }) => {
      calls.push(args);
      if (queue.length === 0) {
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      }
      return queue.shift();
    },
    calls,
  };
}

const CREATE_SEQUENCE = [
  { status: 0, stdout: '', stderr: '' }, // pr list — empty
  { status: 0, stdout: 'https://github.com/o/r/pull/12\n', stderr: '' }, // pr create
  {
    status: 0,
    stdout: '{"number":12,"url":"https://github.com/o/r/pull/12"}',
    stderr: '',
  }, // pr view
];

describe('openOrLocatePr — draft mode (Story #4359)', () => {
  it('opens the PR as a draft when draft:true and keeps the title/body contract', async () => {
    const { spawn, calls } = scriptedGh([...CREATE_SEQUENCE]);
    const result = await openOrLocatePr({
      epicId: 4355,
      headBranch: 'epic/4355',
      draft: true,
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.deepEqual(result, {
      prNumber: 12,
      url: 'https://github.com/o/r/pull/12',
      created: true,
    });
    const createArgs = calls[1];
    assert.equal(createArgs[1], 'create');
    assert.ok(createArgs.includes('--draft'), 'expected --draft in create args');
    const titleIdx = createArgs.indexOf('--title');
    const bodyIdx = createArgs.indexOf('--body');
    assert.equal(createArgs[titleIdx + 1], 'feat: Epic #4355');
    assert.equal(createArgs[bodyIdx + 1], 'Closes #4355');
  });

  it('does NOT pass --draft when draft is omitted (earlyPr=false close-time path)', async () => {
    const { spawn, calls } = scriptedGh([...CREATE_SEQUENCE]);
    await openOrLocatePr({
      epicId: 4355,
      headBranch: 'epic/4355',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    const createArgs = calls[1];
    assert.equal(createArgs[1], 'create');
    assert.ok(
      !createArgs.includes('--draft'),
      'close-time create path must not open a draft',
    );
  });

  it('stays idempotent in draft mode: a second call locates the existing PR', async () => {
    const queue = [
      ...CREATE_SEQUENCE,
      // Second call — locate path (existing PR found on head branch).
      {
        status: 0,
        stdout: '{"number":12,"url":"https://github.com/o/r/pull/12"}',
        stderr: '',
      },
    ];
    const { spawn, calls } = scriptedGh(queue);
    const first = await openOrLocatePr({
      epicId: 4355,
      headBranch: 'epic/4355',
      draft: true,
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    const second = await openOrLocatePr({
      epicId: 4355,
      headBranch: 'epic/4355',
      draft: true,
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.prNumber, second.prNumber);
    assert.equal(first.url, second.url);
    // Only one `gh pr create` fired across both calls (the second call is
    // list-only), so no duplicate draft PR is opened.
    const createCalls = calls.filter((a) => a[1] === 'create');
    assert.equal(createCalls.length, 1);
  });
});

describe('markPrReady (Story #4359)', () => {
  it('shells gh pr ready and returns { pr, ready:true }', async () => {
    const { spawn, calls } = scriptedGh([{ status: 0, stdout: '', stderr: '' }]);
    const result = await markPrReady({
      pr: 'https://github.com/o/r/pull/12',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.deepEqual(result, {
      pr: 'https://github.com/o/r/pull/12',
      ready: true,
    });
    assert.deepEqual(calls[0], [
      'pr',
      'ready',
      'https://github.com/o/r/pull/12',
    ]);
  });

  it('accepts a numeric PR id', async () => {
    const { spawn, calls } = scriptedGh([{ status: 0, stdout: '', stderr: '' }]);
    await markPrReady({ pr: 12, cwd: '/tmp', ghSpawn: spawn });
    assert.deepEqual(calls[0], ['pr', 'ready', '12']);
  });

  it('throws when gh pr ready fails', async () => {
    const { spawn } = scriptedGh([
      { status: 1, stdout: '', stderr: 'could not resolve PR' },
    ]);
    await assert.rejects(
      () => markPrReady({ pr: '12', cwd: '/tmp', ghSpawn: spawn }),
      /gh pr ready failed.*could not resolve PR/,
    );
  });

  it('throws a TypeError on an empty reference', async () => {
    await assert.rejects(() => markPrReady({ pr: '' }), TypeError);
    await assert.rejects(() => markPrReady({ pr: '   ' }), TypeError);
  });
});
