import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baselineComparePreflight,
  scorePostCapture,
} from '../../../.agents/scripts/lib/orchestration/handoff-gates.js';

const ctx = (overrides = {}) => ({
  config: {
    project: { baseBranch: 'main' },
    delivery: {
      quality: {
        gates: {
          maintainability: { enabled: true },
          crap: { enabled: true },
        },
      },
    },
  },
  baseBranch: 'main',
  cwd: '/work',
  evidenceCwd: '/work',
  storyId: 1,
  scripts: { test: 'x', 'test:coverage': 'y' },
  presentBaselines: ['maintainability', 'crap'],
  depositor: 'coverage-capture',
  head: 'h',
  state: {},
  env: {},
  ...overrides,
});

describe('handoff gates', () => {
  it('splits the compare: artifact-free at preflight, readers post-capture', async () => {
    const [check, ...rest] = baselineComparePreflight(ctx());
    assert.deepEqual(rest, []);
    assert.equal(check.key, 'check-baselines-independent');
    assert.match(check.label, /kinds: maintainability/);
    const { gates } = await scorePostCapture(ctx(), async () => ({
      status: 0,
    }));
    assert.deepEqual(
      gates.map((g) => g.name),
      ['quality-preview-crap', 'check-baselines-coverage'],
    );
  });

  it('AC-3: runs every gate past a failure and returns each finding', async () => {
    const ran = [];
    const { failures } = await scorePostCapture(ctx(), async (name) => {
      ran.push(name);
      return { status: 1, output: '', evidencePath: `/${name}.log` };
    });
    assert.equal(ran.length, 2);
    assert.deepEqual(
      failures.map((f) => f.gate),
      ['quality-preview-crap', 'check-baselines-coverage'],
    );
  });

  it('runs no artifact reader after a deferral', async () => {
    const deferred = ctx({ state: { coverageDeferredHead: 'h' } });
    const { gates, failures } = await scorePostCapture(deferred, async () => {
      throw new Error('must not run');
    });
    assert.deepEqual(gates, []);
    assert.deepEqual(failures, []);
  });
});
