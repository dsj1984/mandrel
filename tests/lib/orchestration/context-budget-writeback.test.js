// tests/lib/orchestration/context-budget-writeback.test.js
//
// Story #5313 — the close writes a lower context-budget total back on the
// Story branch through the pre-gate write-back seam. Every collaborator is
// injected so no test spawns git or reads the real tree.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { runContextBudgetWriteback } from '../../../.agents/scripts/lib/orchestration/story-close/context-budget-writeback.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

const BASELINE = {
  toleranceBytes: 2048,
  tiers: { workflow: { totalBytes: 1000, files: [] } },
};

/** A git stub that answers the branch/status/commit questions in order. */
function gitStub({
  branch = 'story-7',
  dirty = '',
  failOn = null,
  onRestore,
} = {}) {
  const calls = [];
  const git = (_cwd, ...args) => {
    calls.push(args);
    const key = args.join(' ');
    if (failOn && key.startsWith(failOn)) throw new Error(`git ${failOn} boom`);
    if (args[0] === 'restore') {
      onRestore?.(args.slice(args.indexOf('--') + 1));
      return '';
    }
    if (key === 'rev-parse --abbrev-ref HEAD') return branch;
    if (key.startsWith('status --porcelain')) return dirty;
    if (key === 'rev-parse --short HEAD') return 'abc1234';
    return '';
  };
  return { git, calls };
}

function harness({
  shrunk = [],
  grown = [],
  absent = [],
  git,
  writeFile,
  root = makeTempDir('ctx-writeback-'),
} = {}) {
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const logs = [];
  const stub = git ?? gitStub();
  const out = runContextBudgetWriteback({
    cwd: root,
    storyId: 7,
    storyBranch: 'story-7',
    config: {},
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    gitSync: stub.git,
    loadBaselineImpl: () => BASELINE,
    resolveDocTiersImpl: () => ({ tiers: {} }),
    diffBudgetImpl: () => ({ grown, shrunk, absent, skipped: [] }),
    buildBaselineImpl: () => ({
      ...BASELINE,
      tiers: { workflow: { totalBytes: 900 } },
    }),
    ...(writeFile ? { writeFile } : {}),
  });
  return { out, root, logs, calls: stub.calls };
}

const REL = 'baselines/context-budget.json';
const SHRUNK = [{ tier: 'workflow', current: 900, baseline: 1000, delta: 100 }];

/** A seeded baseline plus a git stub whose `restore` puts its bytes back. */
function restoringFixture(gitOpts = {}) {
  const root = makeTempDir('ctx-writeback-restore-');
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const original = `${JSON.stringify(BASELINE, null, 2)}\n`;
  fs.writeFileSync(path.join(root, REL), original);
  const git = gitStub({
    ...gitOpts,
    onRestore: (paths) => {
      for (const rel of paths) fs.writeFileSync(path.join(root, rel), original);
    },
  });
  return { root, git, original };
}

describe('runContextBudgetWriteback', () => {
  test('AC-8: a shrunk tier is written back and committed as a baseline-refresh on the branch', () => {
    const { out, root, calls } = harness({
      shrunk: [{ tier: 'workflow', current: 900, baseline: 1000, delta: 100 }],
    });
    assert.equal(out.committed, true);
    assert.equal(out.sha, 'abc1234');
    assert.deepEqual(out.tiers, ['workflow']);
    const written = JSON.parse(
      fs.readFileSync(
        path.join(root, 'baselines', 'context-budget.json'),
        'utf8',
      ),
    );
    assert.equal(written.tiers.workflow.totalBytes, 900);
    const commit = calls.find((c) => c[0] === 'commit');
    assert.match(
      commit[2],
      /^chore\(baselines\): baseline-refresh: lower context-budget totals \(story #7\)$/,
    );
    assert.match(commit[4], /workflow: 1000 -> 900 bytes/);
    assert.deepEqual(
      calls.find((c) => c[0] === 'add'),
      ['add', '--', 'baselines/context-budget.json'],
    );
  });

  test('writes nothing when there is no shrink, or when growth / an unbacked row is present', () => {
    assert.equal(harness().out.reason, 'no-shrink');
    assert.equal(
      harness({
        shrunk: [
          { tier: 'workflow', current: 900, baseline: 1000, delta: 100 },
        ],
        grown: [{ tier: 'alwaysLoaded' }],
      }).out.reason,
      'drift-not-downward',
    );
    assert.equal(
      harness({
        shrunk: [
          { tier: 'workflow', current: 900, baseline: 1000, delta: 100 },
        ],
        absent: [{ tier: 'workflow', path: 'gone.md' }],
      }).out.reason,
      'drift-not-downward',
    );
  });

  test('guards: wrong branch, dirty baseline, missing context — all named skips', () => {
    assert.equal(
      harness({ git: gitStub({ branch: 'main' }) }).out.reason,
      'wrong-branch',
    );
    assert.equal(
      harness({ git: gitStub({ dirty: ' M baselines/context-budget.json' }) })
        .out.reason,
      'dirty-tree',
    );
    assert.equal(runContextBudgetWriteback({}).reason, 'missing-context');
  });

  test('a throw on git add, after the write, restores the baseline and re-throws (Story #5683)', () => {
    const { root, git, original } = restoringFixture({ failOn: 'add' });
    const { out, calls } = harness({ root, git, shrunk: SHRUNK });
    assert.equal(out.committed, false);
    assert.match(out.reason, /^failed: git add boom/);
    assert.deepEqual(
      calls.find((c) => c[0] === 'restore'),
      ['restore', '--staged', '--worktree', '--', REL],
    );
    assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), original);
    assert.equal(calls.filter((c) => c[0] === 'commit').length, 0);
  });

  test('a throw on the write itself restores the baseline and re-throws (Story #5683)', () => {
    const { root, git, original } = restoringFixture();
    const { out, calls } = harness({
      root,
      git,
      shrunk: SHRUNK,
      writeFile: (file) => {
        fs.writeFileSync(file, '{"torn":');
        throw new Error('write boom');
      },
    });
    assert.match(out.reason, /^failed: write boom/);
    assert.deepEqual(
      calls.find((c) => c[0] === 'restore'),
      ['restore', '--staged', '--worktree', '--', REL],
    );
    assert.equal(calls.filter((c) => c[0] === 'add').length, 0);
    assert.equal(fs.readFileSync(path.join(root, REL), 'utf8'), original);
  });

  test('is total: a throwing collaborator is a named skip, never a failed close', () => {
    const out = runContextBudgetWriteback({
      cwd: '/nope',
      storyId: 7,
      storyBranch: 'story-7',
      config: {},
      logger: { info: () => {} },
      gitSync: () => {
        throw new Error('git missing');
      },
    });
    assert.equal(out.committed, false);
    assert.match(out.reason, /failed: git missing/);
  });
});
