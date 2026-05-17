// tests/scripts/check-baselines.unknown-axis.test.js
//
// Story #2193 / Task #2201 — AC-6: the unified `check-baselines.js`
// dispatcher MUST fail closed when a configured floor names an axis the
// rollup does not expose.
//
// Pre-#2193 `compareToFloor` silently skipped unknown axes — a typo like
// `{ '*': { maintainability: 70 } }` against the maintainability rollup
// (which exposes `min` / `p50` / `p95`) passed as "no breach" without
// any operator-visible signal. Task #2201's `assertFloorAxesExist`
// guard wraps `applyFloors` and raises an actionable error before the
// silent-skip comparator runs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  assertFloorAxesExist,
  runCheckBaselines,
} from '../../.agents/scripts/check-baselines.js';
import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function maintainabilityEnvelope({ min }) {
  return {
    $schema: 'maintainability.schema.json',
    kernelVersion: currentKernelVersion('maintainability'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: { '*': { min, p50: 88, p95: 95 } },
    rows: [{ path: 'src/example.js', mi: min }],
  };
}

function setupRepoWithBadFloor() {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-unknown-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: [],
      commands: { lintBaseline: 'echo', test: 'echo', typecheck: 'echo' },
    },
    github: { owner: 'x', repo: 'y' },
    delivery: {
      quality: {
        gates: {
          maintainability: {
            enabled: true,
            baselinePath: 'baselines/maintainability.json',
            tolerance: { kind: 'absolute', value: 0.5 },
            // The pre-#2193 typo: configure the legacy `maintainability`
            // axis against a rollup that exposes `min` / `p50` / `p95`.
            floors: { '*': { maintainability: 70 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  writeJson(
    path.join(root, 'baselines', 'maintainability.json'),
    maintainabilityEnvelope({ min: 85 }),
  );
  return root;
}

describe('check-baselines — unknown floor axis (Story #2193 AC-6)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('throws an actionable error when a configured floor axis is missing from the rollup', async () => {
    root = setupRepoWithBadFloor();
    await assert.rejects(
      () =>
        runCheckBaselines({
          argv: ['--no-friction', '--gate', 'maintainability'],
          cwd: root,
        }),
      (err) => {
        assert.equal(err.code, 'EXIT_CONFIG');
        assert.equal(err.exitCode, 3, 'exit code is EXIT_CONFIG (3)');
        assert.equal(err.kind, 'maintainability');
        assert.equal(err.axis, 'maintainability');
        assert.equal(err.component, '*');
        assert.deepEqual(
          err.availableKeys,
          ['min', 'p50', 'p95'],
          'availableKeys lists the rollup axes the operator can choose from',
        );
        return true;
      },
    );
  });

  it('error message names the missing axis, the component, and the available keys', async () => {
    root = setupRepoWithBadFloor();
    let captured;
    try {
      await runCheckBaselines({
        argv: ['--no-friction', '--gate', 'maintainability'],
        cwd: root,
      });
    } catch (err) {
      captured = err;
    }
    assert.ok(captured, 'runCheckBaselines threw');
    assert.match(
      captured.message,
      /configured floor 'maintainability' not found/,
      'message names the offending floor axis',
    );
    assert.match(
      captured.message,
      /rollup\['\*'\]/,
      'message identifies the rollup component',
    );
    assert.match(
      captured.message,
      /'min'/,
      "message lists at least 'min' among available rollup keys",
    );
    assert.match(
      captured.message,
      /'p50'/,
      "message lists 'p50' among available rollup keys",
    );
    assert.match(
      captured.message,
      /'p95'/,
      "message lists 'p95' among available rollup keys",
    );
    assert.match(
      captured.message,
      /did you mean 'min'\?/,
      'message offers the closest match as a hint',
    );
  });
});

describe('check-baselines — assertFloorAxesExist (pure helper)', () => {
  it('returns silently when every floor axis is present in the aggregate', () => {
    assert.doesNotThrow(() =>
      assertFloorAxesExist(
        'maintainability',
        '*',
        { min: 85, p50: 90, p95: 95 },
        { min: 70 },
      ),
    );
  });

  it('throws an EXIT_CONFIG error tagged with kind/component/axis/availableKeys', () => {
    assert.throws(
      () =>
        assertFloorAxesExist(
          'maintainability',
          '*',
          { min: 85, p50: 90, p95: 95 },
          { maintainability: 70 },
        ),
      (err) => {
        assert.equal(err.code, 'EXIT_CONFIG');
        assert.equal(err.exitCode, 3);
        assert.equal(err.kind, 'maintainability');
        assert.equal(err.component, '*');
        assert.equal(err.axis, 'maintainability');
        assert.deepEqual(err.availableKeys, ['min', 'p50', 'p95']);
        return true;
      },
    );
  });

  it('skips non-numeric floor entries (they are inert in the comparator too)', () => {
    assert.doesNotThrow(() =>
      assertFloorAxesExist(
        'maintainability',
        '*',
        { min: 85 },
        { stranger: 'not-a-number', min: 70 },
      ),
    );
  });

  it('is a no-op when the aggregate or floor is missing', () => {
    assert.doesNotThrow(() =>
      assertFloorAxesExist('maintainability', '*', null, { min: 70 }),
    );
    assert.doesNotThrow(() =>
      assertFloorAxesExist('maintainability', '*', { min: 85 }, null),
    );
  });
});
