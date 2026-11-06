// The `test` delta re-credit, driven with a config loaded from a fixture
// `.agentrc.json` through the real resolver — a hand-built object hid that
// the resolver dropped `project.commands.testChanged`.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../../config-resolver.js';
import { closeTestGate, closeTestScope } from '../skip-branch-test.js';

/** The shared resolver, reached through close's skip-branch entry point. */
const resolveSkipBranchScope = (opts) =>
  closeTestScope({ skipBranch: true, ...opts });
const buildSkipBranchTestGate = ({ config, ...scope }) =>
  closeTestGate(config, scope);

import { applyTestDelta, substituteChangedSince } from '../test-delta.js';

const ROOT = path.resolve('/fixture-5936');
const SINCE = 'c'.repeat(40);
const TEST_CHANGED = 'pnpm vitest run --changed $MANDREL_CHANGED_SINCE';
const FULL_TEST = Object.freeze({ name: 'test', cmd: 'npm', args: ['test'] });

/** Resolve a fixture `.agentrc.json` held in an in-memory fs (only the two calls the resolver makes). */
function loadConfig(commands) {
  const agentrc = path.join(ROOT, '.agentrc.json');
  const body = JSON.stringify({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      ...(commands ? { commands } : {}),
    },
  });
  const fs = {
    existsSync: (p) => p === agentrc,
    readFileSync: () => body,
  };
  return resolveConfig({ cwd: ROOT, ctx: { fs } });
}

function planTestGate(config) {
  const logged = [];
  const gates = applyTestDelta([FULL_TEST], {
    baseSync: { changedPaths: ['src/b.js', 'lib/c.js'], creditedCommit: SINCE },
    config,
    storyId: 5936,
    cwd: ROOT,
    baseBranch: 'main',
    shouldSkipImpl: () => ({ skip: true, reason: 'credited' }),
    getChangedFilesImpl: () => ['src/a.js'],
    log: (m) => logged.push(m),
  });
  return { gate: gates.find((g) => g.name === 'test'), logged };
}

describe('test delta re-credit through the real config resolver', () => {
  it('plans the delta gate from a resolved config that sets testChanged', () => {
    const config = loadConfig({ testChanged: TEST_CHANGED });
    assert.equal(config.project.commands.testChanged, TEST_CHANGED);
    const { gate, logged } = planTestGate(config);
    assert.equal(gate.cmd, 'pnpm');
    assert.deepEqual(gate.args, ['vitest', 'run', '--changed', SINCE]);
    assert.deepEqual(gate.evidenceNote, { scope: 'delta', since: SINCE });
    assert.deepEqual(logged, []);
  });

  for (const [label, commands] of [
    ['absent', undefined],
    ['null', { testChanged: null }],
  ]) {
    it(`keeps the full test gate when testChanged is ${label}`, () => {
      const config = loadConfig(commands);
      assert.equal(config.project.commands.testChanged, null);
      const { gate, logged } = planTestGate(config);
      assert.equal(gate, FULL_TEST);
      assert.equal(logged.length, 1);
      assert.match(logged[0], /no `project\.commands\.testChanged`/);
    });
  }
});

const MERGE_BASE = 'd'.repeat(40);

/** A `gitSpawn`-shaped double answering `merge-base` only. */
function mergeBaseGit(result) {
  const calls = [];
  const git = (cwd, ...args) => {
    calls.push({ cwd, args });
    if (result instanceof Error) throw result;
    return result;
  };
  git.calls = calls;
  return git;
}

describe('skip-branch scope resolver (Story #5961)', () => {
  it('scopes testChanged to the origin/<baseBranch> merge-base', () => {
    const config = loadConfig({ testChanged: TEST_CHANGED });
    const git = mergeBaseGit({ status: 0, stdout: `${MERGE_BASE}\n` });
    const scope = resolveSkipBranchScope({
      config,
      cwd: ROOT,
      baseBranch: 'trunk',
      gitSpawnImpl: git,
    });
    assert.equal(scope.since, MERGE_BASE);
    assert.equal(scope.testChanged.raw, TEST_CHANGED);
    assert.deepEqual(git.calls, [
      { cwd: ROOT, args: ['merge-base', 'origin/trunk', 'HEAD'] },
    ]);
  });

  for (const [label, commands] of [
    ['absent', undefined],
    ['null', { testChanged: null }],
  ]) {
    it(`falls back naming the unset command when testChanged is ${label}`, () => {
      const git = mergeBaseGit({ status: 0, stdout: MERGE_BASE });
      const scope = resolveSkipBranchScope({
        config: loadConfig(commands),
        cwd: ROOT,
        baseBranch: 'main',
        gitSpawnImpl: git,
      });
      assert.match(scope.fallback, /no `project\.commands\.testChanged`/);
      assert.equal(git.calls.length, 0);
    });
  }

  for (const [label, result] of [
    ['exits non-zero', { status: 128, stdout: '' }],
    ['prints nothing', { status: 0, stdout: '  ' }],
    ['throws', new Error('spawn failed')],
  ]) {
    it(`falls back to the full suite when merge-base ${label}`, () => {
      const scope = resolveSkipBranchScope({
        config: loadConfig({ testChanged: TEST_CHANGED }),
        cwd: ROOT,
        baseBranch: 'main',
        gitSpawnImpl: mergeBaseGit(result),
      });
      assert.deepEqual(scope, { fallback: 'merge-base unreadable' });
    });
  }

  it('substitutes only the literal token and sets the env', () => {
    assert.deepEqual(
      substituteChangedSince(
        {
          cmd: 'x',
          args: [
            '--changed',
            '$MANDREL_CHANGED_SINCE',
            'a$MANDREL_CHANGED_SINCE',
          ],
        },
        MERGE_BASE,
      ),
      {
        cmd: 'x',
        args: ['--changed', MERGE_BASE, 'a$MANDREL_CHANGED_SINCE'],
        env: { MANDREL_CHANGED_SINCE: MERGE_BASE },
      },
    );
  });

  it('builds a scoped test gate credited under the full-suite identity', () => {
    const config = loadConfig({ testChanged: TEST_CHANGED });
    const scope = resolveSkipBranchScope({
      config,
      cwd: ROOT,
      baseBranch: 'main',
      gitSpawnImpl: mergeBaseGit({ status: 0, stdout: MERGE_BASE }),
    });
    const gate = buildSkipBranchTestGate({ config, ...scope });
    assert.equal(gate.name, 'test');
    assert.deepEqual(gate.args, ['vitest', 'run', '--changed', MERGE_BASE]);
    assert.deepEqual(gate.env, { MANDREL_CHANGED_SINCE: MERGE_BASE });
    assert.equal(gate.fullSuiteLock, true);
    assert.deepEqual(gate.evidenceIdentity, { cmd: 'npm', args: ['test'] });
    assert.deepEqual(gate.evidenceNote, { scope: 'delta', since: MERGE_BASE });
  });

  it('AC-6: the base-moved delta re-credit still replaces a skip-branch gate, keeping its over-budget flag', () => {
    const config = loadConfig({ testChanged: TEST_CHANGED });
    const scoped = {
      ...buildSkipBranchTestGate({
        config,
        testChanged: { cmd: 'pnpm', args: ['vitest'], raw: 'pnpm vitest' },
        since: MERGE_BASE,
      }),
      deferOnOverBudget: true,
    };
    const gates = applyTestDelta([scoped], {
      baseSync: { changedPaths: ['src/b.js'], creditedCommit: SINCE },
      config,
      storyId: 5961,
      cwd: ROOT,
      baseBranch: 'main',
      shouldSkipImpl: () => ({ skip: true, reason: 'credited' }),
      getChangedFilesImpl: () => ['docs/a.md'],
    });
    assert.deepEqual(gates[0].evidenceNote, { scope: 'delta', since: SINCE });
    assert.match(gates[0].label, /delta since/);
    assert.equal(gates[0].deferOnOverBudget, true);
  });

  it('an ineligible delta over the scoped gate does not claim a full run', () => {
    const config = loadConfig({ testChanged: TEST_CHANGED });
    const scoped = buildSkipBranchTestGate({
      config,
      testChanged: { cmd: 'pnpm', args: ['vitest'], raw: 'pnpm vitest' },
      since: MERGE_BASE,
    });
    const logged = [];
    const gates = applyTestDelta([scoped], {
      baseSync: { changedPaths: ['src/b.js'], creditedCommit: SINCE },
      config,
      storyId: 5961,
      cwd: ROOT,
      baseBranch: 'main',
      shouldSkipImpl: () => ({ skip: false }),
      getChangedFilesImpl: () => ['docs/a.md'],
      log: (m) => logged.push(m),
    });
    assert.equal(gates[0], scoped);
    assert.match(logged[0], /running the skip-branch scoped run/);
  });
});
