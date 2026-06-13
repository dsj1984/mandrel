/**
 * tests/scripts/single-story-init-gh-runner.test.js — Story #4073
 *
 * Verifies that `makeGhRunner` accepts an injectable `spawnImpl` boundary so
 * its success/error handling can be unit-tested without a live `gh` binary.
 *
 * Before #4073 the runner called `spawnSync('gh', …)` directly, leaving its
 * error/exit-code path exercisable only on the slow integration-test path.
 * The injected spawn function is mocked at the subprocess boundary here, per
 * testing-standards § Unit (mock all I/O).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeGhRunner } from '../../.agents/scripts/single-story-init.js';

/**
 * Build a fake `spawnSync` that records its calls and returns a canned
 * `{ status, stdout, stderr }` envelope.
 *
 * @param {{ status?: number|null, stdout?: string, stderr?: string }} result
 */
function makeFakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      status: result.status ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  fn.calls = calls;
  return fn;
}

describe('single-story-init — makeGhRunner', () => {
  it('returns stdout on a zero exit status', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 0, stdout: 'ok-output' });
    const run = makeGhRunner('/repo', spawn);

    // Act
    const out = run(['pr', 'view', '7']);

    // Assert
    assert.equal(out, 'ok-output');
  });

  it('invokes the injected spawn with `gh`, the args, and a shell-free opts bag', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 0, stdout: '' });
    const run = makeGhRunner('/repo', spawn);

    // Act
    run(['issue', 'view', '4073']);

    // Assert — the boundary is exercised without a real child process.
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, 'gh');
    assert.deepEqual(spawn.calls[0].args, ['issue', 'view', '4073']);
    assert.equal(spawn.calls[0].opts.shell, false);
    assert.equal(spawn.calls[0].opts.encoding, 'utf-8');
  });

  it('defaults the spawn cwd to the runner cwd', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 0, stdout: '' });
    const run = makeGhRunner('/repo-root', spawn);

    // Act
    run(['pr', 'list']);

    // Assert
    assert.equal(spawn.calls[0].opts.cwd, '/repo-root');
  });

  it('honours a per-call cwd override', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 0, stdout: '' });
    const run = makeGhRunner('/repo-root', spawn);

    // Act
    run(['pr', 'list'], { cwd: '/elsewhere' });

    // Assert
    assert.equal(spawn.calls[0].opts.cwd, '/elsewhere');
  });

  it('returns an empty string when stdout is undefined on success', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 0, stdout: undefined });
    const run = makeGhRunner('/repo', spawn);

    // Act
    const out = run(['pr', 'list']);

    // Assert
    assert.equal(out, '');
  });

  it('throws with the args, exit code, and stderr on a non-zero status', () => {
    // Arrange
    const spawn = makeFakeSpawn({ status: 1, stderr: 'boom' });
    const run = makeGhRunner('/repo', spawn);

    // Act + Assert
    assert.throws(() => run(['pr', 'view', '7']), /gh pr view 7 exit 1: boom/);
  });

  it('tolerates a missing stderr on the error path', () => {
    // Arrange — non-zero status with undefined stderr must not crash.
    const spawn = makeFakeSpawn({ status: 2, stderr: undefined });
    const run = makeGhRunner('/repo', spawn);

    // Act + Assert
    assert.throws(() => run(['repo', 'view']), /gh repo view exit 2: /);
  });
});
