/**
 * tests/contract/finalize/open-or-locate-pr.test.js
 *
 * Contract test for `openOrLocatePr` — Story #2894 / Task #2908
 * (Epic #2880).
 *
 * Asserts:
 *   1. Locate path — when `gh pr list` returns an existing PR on the
 *      head branch, the helper short-circuits to `{ created: false }`
 *      and skips `gh pr create`.
 *   2. Create path — when `gh pr list` returns empty, the helper calls
 *      `gh pr create` then `gh pr view` to canonicalise the envelope
 *      and returns `{ created: true }`.
 *   3. Idempotency — two back-to-back invocations on the same head
 *      branch return the same `{ prNumber, url }` envelope. The second
 *      invocation MUST take the locate path (no second `gh pr create`).
 *   4. Failure modes — non-zero exits on `gh pr list` / `gh pr create`
 *      / `gh pr view` surface as thrown errors carrying the stderr
 *      detail.
 *   5. Input validation — bad `epicId` / `headBranch` throw TypeError.
 *
 * Also covers the pure parsers (`parsePrListResult`, `parsePrViewResult`).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  openOrLocatePr,
  parsePrListResult,
  parsePrViewResult,
} from '../../../.agents/scripts/lib/orchestration/finalize/open-or-locate-pr.js';

/**
 * Tiny scripted gh-spawn that walks through a queue of stubbed
 * responses. Each call shifts one entry; an empty queue is a test bug
 * (the helper called gh more times than the test expected).
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

describe('parsePrListResult', () => {
  it('parses the jq object form', () => {
    const raw = '{"number":7,"url":"https://github.com/o/r/pull/7"}';
    assert.deepEqual(parsePrListResult(raw), {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('parses the array form (no jq)', () => {
    const raw = '[{"number":7,"url":"https://github.com/o/r/pull/7"}]';
    assert.deepEqual(parsePrListResult(raw), {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
    });
  });

  it('returns null for empty stdout', () => {
    assert.equal(parsePrListResult(''), null);
    assert.equal(parsePrListResult('   '), null);
  });

  it('returns null for malformed JSON', () => {
    assert.equal(parsePrListResult('not json'), null);
  });

  it('returns null when number / url are missing', () => {
    assert.equal(parsePrListResult('{"url":"x"}'), null);
    assert.equal(parsePrListResult('{"number":1}'), null);
  });
});

describe('parsePrViewResult', () => {
  it('parses the canonical view envelope', () => {
    const raw = '{"number":42,"url":"https://github.com/o/r/pull/42"}';
    assert.deepEqual(parsePrViewResult(raw), {
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });
  });
  it('returns null for malformed input', () => {
    assert.equal(parsePrViewResult(''), null);
    assert.equal(parsePrViewResult('garbage'), null);
  });
});

describe('openOrLocatePr', () => {
  it('locates an existing PR and skips create', async () => {
    const { spawn, calls } = scriptedGh([
      {
        status: 0,
        stdout: '{"number":7,"url":"https://github.com/o/r/pull/7"}',
        stderr: '',
      },
    ]);
    const result = await openOrLocatePr({
      epicId: 2880,
      headBranch: 'epic/2880',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.deepEqual(result, {
      prNumber: 7,
      url: 'https://github.com/o/r/pull/7',
      created: false,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'pr');
    assert.equal(calls[0][1], 'list');
  });

  it('creates a PR when the head branch has no open PR', async () => {
    const { spawn, calls } = scriptedGh([
      { status: 0, stdout: '', stderr: '' }, // pr list — empty
      {
        status: 0,
        stdout: 'https://github.com/o/r/pull/99\n',
        stderr: '',
      }, // pr create
      {
        status: 0,
        stdout: '{"number":99,"url":"https://github.com/o/r/pull/99"}',
        stderr: '',
      }, // pr view
    ]);
    const result = await openOrLocatePr({
      epicId: 2880,
      headBranch: 'epic/2880',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.deepEqual(result, {
      prNumber: 99,
      url: 'https://github.com/o/r/pull/99',
      created: true,
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[1][1], 'create');
    assert.equal(calls[2][1], 'view');
    // Default title / body
    const createArgs = calls[1];
    const titleIdx = createArgs.indexOf('--title');
    const bodyIdx = createArgs.indexOf('--body');
    assert.equal(createArgs[titleIdx + 1], 'feat: Epic #2880');
    assert.equal(createArgs[bodyIdx + 1], 'Closes #2880');
  });

  it('is idempotent: a second call on the same head branch locates the existing PR', async () => {
    // First invocation creates; second locates.
    const queue = [
      { status: 0, stdout: '', stderr: '' },
      {
        status: 0,
        stdout: 'https://github.com/o/r/pull/99\n',
        stderr: '',
      },
      {
        status: 0,
        stdout: '{"number":99,"url":"https://github.com/o/r/pull/99"}',
        stderr: '',
      },
      // Second call — locate path
      {
        status: 0,
        stdout: '{"number":99,"url":"https://github.com/o/r/pull/99"}',
        stderr: '',
      },
    ];
    const { spawn } = scriptedGh(queue);
    const first = await openOrLocatePr({
      epicId: 2880,
      headBranch: 'epic/2880',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    const second = await openOrLocatePr({
      epicId: 2880,
      headBranch: 'epic/2880',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    assert.equal(first.prNumber, 99);
    assert.equal(second.prNumber, 99);
    assert.equal(first.url, second.url);
    assert.equal(second.created, false);
  });

  it('honours custom title and body', async () => {
    const { spawn, calls } = scriptedGh([
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: 'https://github.com/o/r/pull/3\n', stderr: '' },
      {
        status: 0,
        stdout: '{"number":3,"url":"https://github.com/o/r/pull/3"}',
        stderr: '',
      },
    ]);
    await openOrLocatePr({
      epicId: 5,
      headBranch: 'epic/5',
      title: 'Custom title',
      body: 'Custom body',
      cwd: '/tmp',
      ghSpawn: spawn,
    });
    const createArgs = calls[1];
    const titleIdx = createArgs.indexOf('--title');
    const bodyIdx = createArgs.indexOf('--body');
    assert.equal(createArgs[titleIdx + 1], 'Custom title');
    assert.equal(createArgs[bodyIdx + 1], 'Custom body');
  });

  it('throws when gh pr list fails', async () => {
    const { spawn } = scriptedGh([
      { status: 1, stdout: '', stderr: 'gh: not authenticated' },
    ]);
    await assert.rejects(
      () =>
        openOrLocatePr({
          epicId: 1,
          headBranch: 'epic/1',
          cwd: '/tmp',
          ghSpawn: spawn,
        }),
      /gh pr list failed.*not authenticated/,
    );
  });

  it('throws when gh pr create fails', async () => {
    const { spawn } = scriptedGh([
      { status: 0, stdout: '', stderr: '' },
      { status: 1, stdout: '', stderr: 'branch protection rule' },
    ]);
    await assert.rejects(
      () =>
        openOrLocatePr({
          epicId: 1,
          headBranch: 'epic/1',
          cwd: '/tmp',
          ghSpawn: spawn,
        }),
      /gh pr create failed.*branch protection rule/,
    );
  });

  it('throws on invalid epicId / headBranch', async () => {
    await assert.rejects(
      () => openOrLocatePr({ epicId: 0, headBranch: 'x' }),
      /epicId/,
    );
    await assert.rejects(
      () => openOrLocatePr({ epicId: 1, headBranch: '' }),
      /headBranch/,
    );
  });
});
