/**
 * format-autofix.test.js — the scoped autofix's captures go through the
 * child-exec wrapper, and its `git status` walks only the candidate paths
 * (Story #5739).
 *
 * The runner below honours `maxBuffer` the way `execFileSync` does: output
 * past the bound (Node's 1 MiB default when none is passed) throws ENOBUFS.
 * Every capture here produces more than 1 MiB, so a raw call that forgot the
 * ceiling fails the test instead of passing on a stub that ignores it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  commitDirtyPaths,
  listDirtyPaths,
  runScopedFormatAutofix,
} from '../../../../.agents/scripts/lib/orchestration/story-close/format-autofix.js';

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

/** An `execFileSync`-shaped runner that enforces the `maxBuffer` it is handed. */
function bufferHonouringRunner(respond) {
  const calls = [];
  const run = (file, args, opts = {}) => {
    calls.push({ file, args, opts });
    const out = respond(file, args) ?? '';
    if (out.length > (opts.maxBuffer ?? NODE_DEFAULT_MAX_BUFFER)) {
      const err = new Error(`spawnSync ${file} ENOBUFS`);
      err.code = 'ENOBUFS';
      throw err;
    }
    return out;
  };
  return { calls, run };
}

/** Enough changed paths that each listing of them is well over 1 MiB. */
const CHANGED = Array.from(
  { length: 12_000 },
  (_, i) => `src/a-deliberately-long-directory-name/file-${i}.json`,
);
const OVER_ONE_MIB = 'x'.repeat(NODE_DEFAULT_MAX_BUFFER + 1024);

const silentLogger = () => {
  const warns = [];
  return { warns, info: () => {}, warn: (msg) => warns.push(msg) };
};

describe('runScopedFormatAutofix — captures larger than 1 MiB (Story #5739)', () => {
  it('reads a >1 MiB diff, formatter stdout and status through the wrapper ceiling', () => {
    const state = { formatted: false };
    const { calls, run } = bufferHonouringRunner((file, args) => {
      if (file !== 'git') {
        state.formatted = true;
        return OVER_ONE_MIB;
      }
      if (args[0] === 'diff') return `${CHANGED.join('\n')}\n`;
      if (args[0] === 'status') {
        return state.formatted ? CHANGED.map((p) => ` M ${p}`).join('\n') : '';
      }
      if (args[1] === '--abbrev-ref') return 'story-5739\n';
      if (args[0] === 'rev-parse') return 'abc1234\n';
      return '';
    });
    const logger = silentLogger();

    const result = runScopedFormatAutofix({
      cwd: '/repo',
      storyId: 5739,
      baseBranch: 'main',
      storyBranch: 'story-5739',
      logger,
      spawnSync: run,
    });

    assert.equal(result.committed, true, logger.warns.join('\n'));
    assert.equal(result.modifiedPaths.length, CHANGED.length);
    assert.equal(
      logger.warns.some((msg) => /exited non-zero/.test(msg)),
      false,
      'the formatter capture must not overflow',
    );
    const formatter = calls.find((c) => c.file !== 'git');
    assert.ok(formatter.opts.maxBuffer > NODE_DEFAULT_MAX_BUFFER);
  });

  it('runs git status only over the candidate paths, never the whole tree', () => {
    const { calls, run } = bufferHonouringRunner((file, args) => {
      if (file === 'git' && args[0] === 'diff') return 'a.json\nb.yml\n';
      return '';
    });
    runScopedFormatAutofix({
      cwd: '/repo',
      storyId: 5739,
      baseBranch: 'main',
      storyBranch: 'story-5739',
      logger: silentLogger(),
      spawnSync: run,
    });
    const statusCalls = calls.filter(
      (c) => c.file === 'git' && c.args[0] === 'status',
    );
    assert.equal(statusCalls.length, 2, 'before and after the formatter');
    for (const call of statusCalls) {
      assert.deepEqual(call.args, [
        'status',
        '--porcelain',
        '--',
        'a.json',
        'b.yml',
      ]);
    }
  });
});

describe('format-autofix git plumbing scoping', () => {
  it('listDirtyPaths stays whole-tree when no paths are given', () => {
    const seen = [];
    listDirtyPaths('/repo', (args) => {
      seen.push(args);
      return '';
    });
    assert.deepEqual(seen, [['status', '--porcelain']]);
  });

  it('commitDirtyPaths limits add and commit to the given paths', () => {
    const seen = [];
    commitDirtyPaths({
      cwd: '/repo',
      subject: 'fix: x',
      paths: ['a.json'],
      git: (args) => {
        seen.push(args);
        return 'abc\n';
      },
    });
    assert.deepEqual(seen.slice(0, 2), [
      ['add', '-u', '--', 'a.json'],
      ['commit', '-m', 'fix: x', '--', 'a.json'],
    ]);
  });
});
