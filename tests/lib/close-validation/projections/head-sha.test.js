// tests/lib/close-validation/projections/head-sha.test.js
/**
 * Story #1850 / Task #1873 — unit tests for the extracted `defaultGetHeadSha`
 * helper.
 *
 * The helper resolves `git rev-parse HEAD` for the supplied cwd, returning
 * `null` on any failure path so the evidence-skip layer in
 * `runCloseValidation` falls back to "run the gate" rather than throwing.
 * Tests inject a fake `gitSpawn` so the suite never shells out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultGetHeadSha } from '../../../../.agents/scripts/lib/close-validation/projections/head-sha.js';

describe('defaultGetHeadSha — success', () => {
  it('returns the trimmed SHA when git exits cleanly', () => {
    const gitSpawn = (_cwd, ...args) => {
      assert.deepEqual(args, ['rev-parse', 'HEAD']);
      return { status: 0, stdout: 'abc1234deadbeef\n', stderr: '' };
    };
    const result = defaultGetHeadSha('/repo', gitSpawn);
    assert.equal(result, 'abc1234deadbeef');
  });

  it('forwards the cwd argument to the injected gitSpawn', () => {
    const seen = [];
    const gitSpawn = (cwd, ...args) => {
      seen.push({ cwd, args });
      return { status: 0, stdout: 'sha\n', stderr: '' };
    };
    defaultGetHeadSha('/path/to/worktree', gitSpawn);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cwd, '/path/to/worktree');
  });
});

describe('defaultGetHeadSha — failure paths', () => {
  it('returns null when git exits non-zero', () => {
    const gitSpawn = () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repo',
    });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });

  it('returns null when stdout is empty', () => {
    const gitSpawn = () => ({ status: 0, stdout: '', stderr: '' });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });

  it('returns null when stdout is whitespace-only', () => {
    const gitSpawn = () => ({ status: 0, stdout: '   \n', stderr: '' });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });

  it('returns null and never throws when gitSpawn throws', () => {
    const gitSpawn = () => {
      throw new Error('spawn ENOENT');
    };
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });

  it('returns null when stdout is undefined', () => {
    const gitSpawn = () => ({ status: 0, stdout: undefined, stderr: '' });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });
});
