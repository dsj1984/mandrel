// tests/lib/orchestration/lifecycle/pr-watch-with-update.test.js
/**
 * Unit tests for the `pr-watch-with-update.js` CLI (Story #3902).
 *
 * The CLI used to be an empty-bus emit shim that watched nothing and
 * always exited 0; Phase 8 therefore advanced to auto-merge with CI red
 * or still running. Story #3902 un-shimmed it onto the shared
 * `watchPrToTerminal` primitive. These tests pin the three load-bearing
 * paths through `runPrWatch` with injected `gh` spawns (no real network,
 * no real `process.exit`):
 *
 *   - green  → every required check terminal + green → exit 0
 *   - red    → a required check fails → exit 1, red check named in map
 *   - BEHIND → all green but PR is BEHIND base → one update-branch +
 *              re-poll → exit 0
 *
 * Plus the guard rails: a malformed `--pr` throws, and an unresolvable
 * `gh pr checks` failure exits non-zero while still printing the map.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPrWatch } from '../../../../.agents/scripts/pr-watch-with-update.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function collectPrint() {
  const lines = [];
  return { print: (line) => lines.push(line), lines };
}

const greenChecks = {
  status: 0,
  stdout: JSON.stringify([
    { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
    { name: 'baselines', state: 'SUCCESS', bucket: 'pass' },
  ]),
  stderr: '',
};

describe('runPrWatch — argument validation', () => {
  it('throws on a non-positive --pr', async () => {
    await assert.rejects(
      () => runPrWatch({ prNumber: 0, logger: quietLogger() }),
      /positive integer/,
    );
    await assert.rejects(
      () => runPrWatch({ prNumber: Number.NaN, logger: quietLogger() }),
      /positive integer/,
    );
  });
});

describe('runPrWatch — green path', () => {
  it('exits 0 and prints the outcomes map when every required check is green', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 42,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => greenChecks,
      // PR is CLEAN — no BEHIND recovery needed.
      ghPrViewFn: () => ({
        status: 0,
        stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.terminal, true);
    assert.deepEqual(out.checkOutcomes, {
      'Validate and Test': 'success',
      baselines: 'success',
    });
  });
});

describe('runPrWatch — red path', () => {
  it('exits 1 and names the failing check in the printed map', async () => {
    const { print, lines } = collectPrint();
    let errorLine = '';
    const code = await runPrWatch({
      prNumber: 7,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 0,
        stdout: JSON.stringify([
          { name: 'Validate and Test', state: 'SUCCESS', bucket: 'pass' },
          { name: 'baselines', state: 'FAILURE', bucket: 'fail' },
        ]),
        stderr: '',
      }),
      logger: {
        ...quietLogger(),
        error: (m) => {
          errorLine = m;
        },
      },
      print,
    });

    assert.equal(code, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, false);
    assert.equal(out.terminal, true);
    assert.equal(out.checkOutcomes.baselines, 'failure');
    assert.match(errorLine, /baselines=failure/);
  });
});

describe('runPrWatch — BEHIND recovery path', () => {
  it('issues one update-branch when all green but BEHIND, then exits 0', async () => {
    const { print, lines } = collectPrint();
    const calls = [];
    const viewResponses = [
      { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'BEHIND' }) },
      { status: 0, stdout: JSON.stringify({ mergeStateStatus: 'CLEAN' }) },
    ];
    let viewIdx = 0;

    const code = await runPrWatch({
      prNumber: 99,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => {
        calls.push('checks');
        return greenChecks;
      },
      ghPrViewFn: () => {
        calls.push('view');
        const r = viewResponses[Math.min(viewIdx, viewResponses.length - 1)];
        viewIdx += 1;
        return { ...r, stderr: '' };
      },
      ghPrUpdateBranchFn: () => {
        calls.push('update-branch');
        return { status: 0, stdout: '', stderr: '' };
      },
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 0);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, true);
    assert.equal(out.updatesApplied, 1);
    // Canonical order: checks → view(BEHIND) → update-branch → ...
    const ubIdx = calls.indexOf('update-branch');
    assert.ok(ubIdx > 0, 'update-branch must be issued');
    assert.equal(calls[ubIdx - 1], 'view');
    assert.equal(
      calls.filter((c) => c === 'update-branch').length,
      1,
      'exactly one update-branch on a single BEHIND→CLEAN transition',
    );
  });
});

describe('runPrWatch — unresolvable gh failure', () => {
  it('exits 1 and still prints a map carrying the error', async () => {
    const { print, lines } = collectPrint();
    const code = await runPrWatch({
      prNumber: 13,
      pollIntervalMs: 0,
      sleepFn: async () => {},
      ghPrChecksFn: () => ({
        status: 1,
        stdout: '',
        stderr: 'gh: not authenticated',
      }),
      logger: quietLogger(),
      print,
    });

    assert.equal(code, 1);
    const out = JSON.parse(lines[0]);
    assert.equal(out.green, false);
    assert.ok(out.error, 'error field must be present');
    assert.deepEqual(out.checkOutcomes, {});
  });
});
