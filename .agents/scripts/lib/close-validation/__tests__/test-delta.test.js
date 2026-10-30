// The `test` delta re-credit, driven with a config loaded from a fixture
// `.agentrc.json` through the real resolver — a hand-built object hid that
// the resolver dropped `project.commands.testChanged`.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../../config-resolver.js';
import { applyTestDelta } from '../test-delta.js';

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
