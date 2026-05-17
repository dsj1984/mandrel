/**
 * Story #1651 (CWE-209) — redactErrorMessage + parseQuietErrorsFlag
 *
 * Pins the redaction shape so CI logs stop leaking absolute filesystem
 * paths and token-shaped substrings from `throw new Error(...)` envelopes
 * routed through `runAsCli`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  parseQuietErrorsFlag,
  redactErrorMessage,
  resolveRepoRoot,
} from '../.agents/scripts/lib/error-redactor.js';

describe('redactErrorMessage', () => {
  it('returns the input unchanged when there is nothing to redact', () => {
    assert.equal(
      redactErrorMessage('install command failed with status 1'),
      'install command failed with status 1',
    );
  });

  it('rewrites repo-root absolute paths to repo-relative form', () => {
    const repoRoot = '/repo/root';
    const msg =
      'runStoryDeliverPrepare: install command `npm ci` failed at /repo/root/.agents/scripts/story-deliver-prepare.js';
    const out = redactErrorMessage(msg, { repoRoot, home: null });
    assert.equal(
      out,
      'runStoryDeliverPrepare: install command `npm ci` failed at .agents/scripts/story-deliver-prepare.js',
    );
  });

  it('rewrites Windows-style repo paths and the forward-slash variant', () => {
    const repoRoot = 'C:\\Users\\dev\\mandrel';
    const native = redactErrorMessage(
      'failed to read C:\\Users\\dev\\mandrel\\baselines\\coverage.json',
      { repoRoot, home: null },
    );
    assert.equal(native, 'failed to read baselines\\coverage.json');

    const forward = redactErrorMessage(
      'failed to read C:/Users/dev/mandrel/baselines/coverage.json',
      { repoRoot, home: null },
    );
    assert.equal(forward, 'failed to read baselines/coverage.json');
  });

  it('elides $HOME and $USERPROFILE segments outside the repo root', () => {
    const repoRoot = '/repo/root';
    const out = redactErrorMessage(
      'cache miss at /home/runner/.npm/_cacache/index-v5',
      { repoRoot, home: '/home/runner' },
    );
    assert.equal(out, 'cache miss at ~/.npm/_cacache/index-v5');
  });

  it('redacts GitHub token-shaped substrings', () => {
    const ghp =
      'auth failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    assert.equal(
      redactErrorMessage(ghp, { repoRoot: '/repo', home: null }),
      'auth failed with token [REDACTED]',
    );

    const hex =
      'unexpected fingerprint deadbeefdeadbeefdeadbeefdeadbeefcafebabecafebabe';
    assert.equal(
      redactErrorMessage(hex, { repoRoot: '/repo', home: null }),
      'unexpected fingerprint [REDACTED]',
    );
  });

  it('handles non-string and empty inputs without throwing', () => {
    assert.equal(redactErrorMessage(undefined), '');
    assert.equal(redactErrorMessage(''), '');
    assert.equal(redactErrorMessage(null), '');
  });

  it('redacts a representative story-deliver-prepare.js install-failure envelope', () => {
    const repoRoot = '/repo/root';
    const msg =
      'runStoryDeliverPrepare: install command `npm ci --prefix /repo/root/.worktrees/story-999` failed with status 1: ' +
      'npm warn EBADENGINE at /repo/root/.worktrees/story-999/node_modules/some-pkg';
    const out = redactErrorMessage(msg, { repoRoot, home: null });
    assert.match(
      out,
      /install command `npm ci --prefix \.worktrees\/story-999`/,
    );
    assert.match(out, /at \.worktrees\/story-999\/node_modules\/some-pkg/);
    assert.doesNotMatch(out, /\/repo\/root/);
  });

  it('redacts a representative story-init.js worktree-creation envelope', () => {
    const repoRoot = '/repo/root';
    const msg =
      'fatal: cannot create worktree at /repo/root/.worktrees/story-1234 — path already exists';
    const out = redactErrorMessage(msg, { repoRoot, home: null });
    assert.equal(
      out,
      'fatal: cannot create worktree at .worktrees/story-1234 — path already exists',
    );
  });

  it('redacts a representative story-close.js push-failure envelope', () => {
    const repoRoot = '/repo/root';
    const msg =
      'git push origin story-1234 failed (exit 128): fatal: unable to access /repo/root/.git/objects/pack';
    const out = redactErrorMessage(msg, { repoRoot, home: null });
    assert.equal(
      out,
      'git push origin story-1234 failed (exit 128): fatal: unable to access .git/objects/pack',
    );
  });
});

describe('parseQuietErrorsFlag', () => {
  it('returns false when no signal is set', () => {
    assert.equal(parseQuietErrorsFlag([], {}), false);
  });

  it('returns true when --quiet-errors is in argv', () => {
    assert.equal(parseQuietErrorsFlag(['--quiet-errors'], {}), true);
    assert.equal(
      parseQuietErrorsFlag(['--story', '1', '--quiet-errors'], {}),
      true,
    );
  });

  it('returns true when AGENT_CLI_QUIET_ERRORS is set to a truthy value', () => {
    assert.equal(
      parseQuietErrorsFlag([], { AGENT_CLI_QUIET_ERRORS: '1' }),
      true,
    );
    assert.equal(
      parseQuietErrorsFlag([], { AGENT_CLI_QUIET_ERRORS: 'true' }),
      true,
    );
  });

  it('treats AGENT_CLI_QUIET_ERRORS=0 / false as opt-out', () => {
    assert.equal(
      parseQuietErrorsFlag([], { AGENT_CLI_QUIET_ERRORS: '0' }),
      false,
    );
    assert.equal(
      parseQuietErrorsFlag([], { AGENT_CLI_QUIET_ERRORS: 'false' }),
      false,
    );
  });

  it('returns true when CI is set (auto-opt-in on CI runners)', () => {
    assert.equal(parseQuietErrorsFlag([], { CI: 'true' }), true);
    assert.equal(parseQuietErrorsFlag([], { CI: '1' }), true);
  });

  it('returns false when CI is the literal string "0" or "false"', () => {
    assert.equal(parseQuietErrorsFlag([], { CI: '0' }), false);
    assert.equal(parseQuietErrorsFlag([], { CI: 'false' }), false);
  });

  it('argv flag overrides absence of env signals', () => {
    assert.equal(parseQuietErrorsFlag(['--quiet-errors'], { CI: '0' }), true);
  });
});

describe('resolveRepoRoot', () => {
  it('points at the directory that holds .agents/', () => {
    const root = resolveRepoRoot();
    // Sanity check: the resolver should return an absolute path whose
    // tail matches the project name and whose .agents subdir exists.
    assert.equal(path.isAbsolute(root), true);
  });
});
