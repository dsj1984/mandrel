// tests/lib/orchestration/pr-watch.test.js
/**
 * Unit tests for the PR CI-watch loop and its pure helpers
 * (Story #2256; re-pointed by Story #5006, re-homed by Story #5024).
 *
 * Acceptance contract:
 *   - Required-check names come from `gh pr checks --required` at
 *     runtime — NOT from `.agentrc.json.branchProtection.requiredChecks`.
 *   - The loop polls until every check is terminal and returns the verdict.
 *     (Story #5006 deleted the `Watcher` bus listener that wrapped it — the
 *     `epic.watch.start` / `.end` emits and their schemas were already gone,
 *     so nothing drove it. Story #5024 retired the bus itself and re-homed
 *     the primitive at `lib/orchestration/pr-watch.js`; the returned verdict
 *     is the whole surface.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allTerminal,
  parseGhPrChecks,
  pollUntilTerminal,
  reduceOutcomes,
  watchPrToTerminal,
} from '../../../.agents/scripts/lib/orchestration/pr-watch.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

describe('parseGhPrChecks', () => {
  it('parses the JSON array form', () => {
    const out = parseGhPrChecks(
      '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'lint');
  });

  it('returns [] for malformed JSON', () => {
    assert.deepEqual(parseGhPrChecks('not json'), []);
  });

  it('drops entries without a name', () => {
    const out = parseGhPrChecks('[{"state":"SUCCESS"},{"name":"lint"}]');
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'lint');
  });
});

describe('reduceOutcomes', () => {
  it('builds a name → outcome map and prefers state over bucket', () => {
    const out = reduceOutcomes([
      { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: '', bucket: 'pending' },
    ]);
    assert.deepEqual(out, { lint: 'success', test: 'pending' });
  });

  it('last-write-wins on duplicate names', () => {
    const out = reduceOutcomes([
      { name: 'lint', state: 'FAILURE' },
      { name: 'lint', state: 'SUCCESS' },
    ]);
    assert.deepEqual(out, { lint: 'success' });
  });
});

describe('allTerminal', () => {
  it('true when every outcome is terminal', () => {
    assert.equal(allTerminal({ a: 'success', b: 'failure' }), true);
  });

  it('false when any outcome is pending', () => {
    assert.equal(allTerminal({ a: 'success', b: 'pending' }), false);
  });
});

describe('pollUntilTerminal', () => {
  it('returns immediately when initial outcomes are already terminal', async () => {
    const ghCalls = [];
    const result = await pollUntilTerminal({
      prUrl: 'https://github.com/o/r/pull/1',
      cwd: '/tmp',
      outcomes: { lint: 'success' },
      polls: 0,
      maxPolls: 5,
      ghPrChecksFn: () => {
        ghCalls.push(1);
        return { status: 0, stdout: '[]', stderr: '' };
      },
      pollIntervalMs: 0,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });
    assert.deepEqual(result.outcomes, { lint: 'success' });
    assert.equal(result.polls, 0);
    assert.equal(ghCalls.length, 0, 'no gh calls when already terminal');
  });

  it('polls until outcomes go terminal', async () => {
    const responses = [
      {
        status: 8,
        stdout: '[{"name":"lint","state":"","bucket":"pending"}]',
        stderr: '',
      },
      {
        status: 0,
        stdout: '[{"name":"lint","state":"SUCCESS","bucket":"pass"}]',
        stderr: '',
      },
    ];
    let idx = 0;
    const result = await pollUntilTerminal({
      prUrl: 'https://github.com/o/r/pull/2',
      cwd: '/tmp',
      outcomes: { lint: 'pending' },
      polls: 0,
      maxPolls: 5,
      ghPrChecksFn: () => responses[Math.min(idx++, responses.length - 1)],
      pollIntervalMs: 0,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });
    assert.deepEqual(result.outcomes, { lint: 'success' });
    assert.equal(result.polls, 2);
  });

  it('stops at maxPolls cap and returns pending outcomes', async () => {
    const result = await pollUntilTerminal({
      prUrl: 'https://github.com/o/r/pull/3',
      cwd: '/tmp',
      outcomes: { slow: 'pending' },
      polls: 0,
      maxPolls: 3,
      ghPrChecksFn: () => ({
        status: 8,
        stdout: '[{"name":"slow","state":"","bucket":"pending"}]',
        stderr: '',
      }),
      pollIntervalMs: 0,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });
    assert.equal(result.polls, 3);
    assert.equal(result.outcomes.slow, 'pending');
  });

  it('skips a transient gh failure and continues polling', async () => {
    const warnings = [];
    const responses = [
      { status: 5, stdout: '', stderr: 'transient error' },
      { status: 0, stdout: '[{"name":"lint","state":"SUCCESS"}]', stderr: '' },
    ];
    let idx = 0;
    const result = await pollUntilTerminal({
      prUrl: 'https://github.com/o/r/pull/4',
      cwd: '/tmp',
      outcomes: { lint: 'pending' },
      polls: 0,
      maxPolls: 5,
      ghPrChecksFn: () => responses[Math.min(idx++, responses.length - 1)],
      pollIntervalMs: 0,
      sleepFn: async () => {},
      logger: { warn: (msg) => warnings.push(msg) },
    });
    assert.deepEqual(result.outcomes, { lint: 'success' });
    assert.equal(result.polls, 2);
    assert.equal(warnings.length, 1, 'transient failure logged once');
    assert.match(warnings[0], /transient failure/);
  });

  it('resumes from a non-zero polls offset', async () => {
    const result = await pollUntilTerminal({
      prUrl: 'https://github.com/o/r/pull/5',
      cwd: '/tmp',
      outcomes: { lint: 'pending' },
      polls: 2,
      maxPolls: 4,
      ghPrChecksFn: () => ({
        status: 0,
        stdout: '[{"name":"lint","state":"SUCCESS"}]',
        stderr: '',
      }),
      pollIntervalMs: 0,
      sleepFn: async () => {},
      logger: { warn: () => {} },
    });
    assert.deepEqual(result.outcomes, { lint: 'success' });
    assert.equal(result.polls, 3, 'poll counter increments from the offset');
  });
});

describe('watchPrToTerminal (bus-free)', () => {
  it('watches to terminal with runtime-resolved required checks', async () => {
    let ghCalls = 0;
    const verdict = await watchPrToTerminal({
      prUrl: 'https://github.com/owner/repo/pull/9',
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 5,
      maxUpdates: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        ghCalls += 1;
        // Both ticks return all-terminal — single iteration.
        return {
          status: 0,
          stdout: JSON.stringify([
            { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
            { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
          ]),
          stderr: '',
        };
      },
      logger: quietLogger(),
    });

    assert.equal(verdict.terminal, true);
    assert.equal(verdict.green, true);
    assert.deepEqual(
      verdict.requiredChecks,
      ['Validate and Test', 'baselines'],
      'required-check names resolved from the runtime gh probe',
    );
    // First probe + one terminal iteration (the while-loop exits
    // before a second probe because outcomes are already terminal).
    assert.equal(ghCalls, 1);
  });

  it('required-check names come from gh, NOT .agentrc.json', async () => {
    // The loop accepts no agentrc/config argument at all — required checks
    // are resolved exclusively from the `ghPrChecksFn` return value. A
    // future attempt to plumb branch-protection config in would have to
    // change this signature, which is what the assertion guards.
    const verdict = await watchPrToTerminal({
      prUrl: 'https://github.com/o/r/pull/1',
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 1,
      maxUpdates: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 0,
        stdout: '[{"name":"gh-resolved-only","state":"SUCCESS"}]',
        stderr: '',
      }),
      logger: quietLogger(),
      // Deliberately passed and deliberately ignored.
      config: {
        github: {
          branchProtection: { requiredChecks: [{ name: 'from-config' }] },
        },
      },
    });
    assert.deepEqual(verdict.requiredChecks, ['gh-resolved-only']);
  });

  it('reports gh-checks-failed when the probe faults with no parseable body', async () => {
    const verdict = await watchPrToTerminal({
      prUrl: 'https://github.com/o/r/pull/1',
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 5,
      maxUpdates: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      logger: quietLogger(),
    });
    assert.equal(verdict.requiredChecksEmpty, true);
    assert.equal(verdict.terminal, false);
    assert.equal(verdict.green, false);
    assert.match(verdict.error, /gh-checks-failed/);
  });

  it('distinguishes an empty required-check set from a gh fault', async () => {
    const verdict = await watchPrToTerminal({
      prUrl: 'https://github.com/o/r/pull/1',
      cwd: '/tmp',
      pollIntervalMs: 0,
      maxPolls: 5,
      maxUpdates: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
      logger: quietLogger(),
    });
    assert.equal(verdict.requiredChecksEmpty, true);
    assert.match(verdict.error, /gh-checks-empty/);
  });
});

describe('watchPrToTerminal — the default sleeper', () => {
  it('polls through a real zero-delay sleep when no sleepFn is injected', async () => {
    // The CLI injects no sleeper; this is the path it takes.
    const probes = [
      {
        status: 8,
        stdout: JSON.stringify([{ name: 'test', state: 'PENDING' }]),
      },
      {
        status: 0,
        stdout: JSON.stringify([{ name: 'test', state: 'SUCCESS' }]),
      },
    ];
    let i = 0;
    const result = await watchPrToTerminal({
      prUrl: '1',
      cwd: '.',
      maxPolls: 3,
      maxUpdates: 0,
      pollIntervalMs: 0,
      ghPrChecksFn: () => probes[Math.min(i++, probes.length - 1)],
      logger: quietLogger(),
    });
    assert.equal(result.green, true);
    assert.equal(result.polls, 1);
  });
});
