import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baselineComparePreflight,
  carryCredit,
  scorePostCapture,
} from '../../../.agents/scripts/lib/orchestration/handoff-gates.js';
import { runPreflightLanes } from '../../../.agents/scripts/lib/orchestration/preflight-lanes.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import {
  dirtyTreeReason,
  hashCommandConfig,
  loadEvidence,
} from '../../../.agents/scripts/lib/validation-evidence.js';

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

const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function stubGit(status) {
  return (_cwd, cmd) => {
    if (cmd === 'status') {
      if (status instanceof Error) throw status;
      return typeof status === 'number'
        ? { status, stdout: '' }
        : { status: 0, stdout: status };
    }
    return { status: 0, stdout: TREE };
  };
}

function creditCtx(status) {
  const dir = makeTempDir('handoff-credit-');
  const lines = [];
  return {
    storyId: 6078,
    head: HEAD,
    cwd: dir,
    evidenceCwd: dir,
    git: stubGit(status),
    env: {},
    progress: (_step, line) => lines.push(line),
    lines,
  };
}

const records = (c) =>
  loadEvidence(6078, { cwd: c.evidenceCwd, standalone: true }).records;

const DIRTY_CASES = [
  ['a modified file', ' M a.js'],
  ['an untracked file', '?? new-helper.ts'],
  ['a failing probe', 128],
  ['a throwing probe', new Error('spawn failed')],
];

describe('dirtyTreeReason', () => {
  it('is null on a clean tree and names the first path otherwise', () => {
    assert.equal(dirtyTreeReason('/w', stubGit('')), null);
    assert.match(
      dirtyTreeReason('/w', stubGit(' M a.js\n?? b.js')),
      /a\.js, 2 changed path/,
    );
    assert.match(dirtyTreeReason('/w', stubGit(1)), /probe failed/);
  });
});

describe('carryCredit on a dirty tree', () => {
  const credit = {
    head: 'old',
    configHash: hashCommandConfig({ cmd: 'npm', args: ['run', 'lint'] }),
  };
  for (const [name, status] of DIRTY_CASES) {
    it(`records nothing for ${name} and returns the credit unchanged`, () => {
      const c = creditCtx(status);
      assert.equal(carryCredit(c, 'lint', credit), credit);
      assert.deepEqual(records(c), []);
      assert.match(c.lines.join('\n'), /lint credit not carried/);
    });
  }

  it('records on a clean tree, as before', () => {
    const c = creditCtx('');
    assert.equal(carryCredit(c, 'lint', credit).head, HEAD);
    assert.equal(records(c).length, 1);
  });
});

describe('preflight reconcile on a dirty tree', () => {
  const deposit = { cmd: 'npm', args: ['run', 'lint'] };
  const run = (c) =>
    runPreflightLanes(c, [{ key: 'lint', deposit }], 1, async () => null);

  for (const [name, status] of DIRTY_CASES) {
    it(`re-records nothing for ${name}`, async () => {
      const c = creditCtx(status);
      await run(c);
      assert.deepEqual(records(c), []);
      assert.match(c.lines.join('\n'), /lint deposit not re-recorded/);
    });
  }

  it('re-records a passed deposit on a clean tree', async () => {
    const c = creditCtx('');
    await run(c);
    const [record] = records(c);
    assert.equal(record.gateName, 'lint');
    assert.equal(
      record.commandConfigHash,
      hashCommandConfig({ ...deposit, cwd: c.cwd }),
    );
  });
});
