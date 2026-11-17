import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  armGitGuard,
  assertGitAllowed,
} from '../../.agents/scripts/lib/git-test-guard.js';
import { gitSpawn, gitSync } from '../../.agents/scripts/lib/git-utils.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

const TEST_GUARD_ROOT_ENV = 'MANDREL_TEST_GUARD_ROOT';

describe('git test guard', () => {
  let repo;
  let saved;

  beforeEach(() => {
    repo = makeGitRepo({ prefix: 'guard-' });
    saved = process.env[TEST_GUARD_ROOT_ENV];
    process.env[TEST_GUARD_ROOT_ENV] = repo;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[TEST_GUARD_ROOT_ENV];
    else process.env[TEST_GUARD_ROOT_ENV] = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('refuses a branch-moving command in the guarded checkout before git runs', () => {
    const head = gitSync(repo, 'rev-parse', 'HEAD');
    assert.throws(
      () => gitSpawn(repo, 'checkout', '-b', 'other'),
      /git checkout refused in the checkout under test/,
    );
    assert.throws(
      () => gitSync(repo, '-c', 'a.b=c', 'merge', '--ff-only', 'x'),
      /git merge refused/,
    );
    assert.throws(() => gitSpawn(repo, 'branch', '-f', 'main', head), /branch/);
    assert.equal(gitSync(repo, 'rev-parse', 'HEAD'), head);
  });

  it('lets read-only commands, plain branch listing and other repos through', () => {
    assert.equal(gitSpawn(repo, 'status', '--short').status, 0);
    assert.equal(gitSpawn(repo, 'branch', '--list').status, 0);
    const nested = path.join(repo, 'fixture');
    fs.mkdirSync(nested);
    execFileSync('git', ['init', '-q', nested]);
    assert.equal(gitSpawn(nested, 'checkout', '-q', '-b', 'x').status, 0);
  });

  it('is a no-op when the guard root is unset', () => {
    assert.doesNotThrow(() => assertGitAllowed(repo, ['checkout', 'main'], {}));
  });

  it('arms every test child with the checkout under test', () => {
    const env = armGitGuard({}, {});
    assert.equal(
      fs.realpathSync(env[TEST_GUARD_ROOT_ENV]),
      fs.realpathSync(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
        }).trim(),
      ),
    );
    const kept = armGitGuard({}, { [TEST_GUARD_ROOT_ENV]: '/x' });
    assert.equal(kept[TEST_GUARD_ROOT_ENV], '/x');
  });
});
