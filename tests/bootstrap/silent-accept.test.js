/**
 * silent-accept.test — Story #2121
 *
 * Exercises `resolveSilentAccept` from bootstrap.js: which keys can be
 * auto-accepted from inferred git defaults without prompting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveSilentAccept } from '../../.agents/scripts/bootstrap.js';

describe('resolveSilentAccept', () => {
  const FULL_DEFAULTS = {
    owner: 'acme',
    repo: 'widget',
    baseBranch: 'main',
    operatorHandle: 'octocat',
  };

  it('returns every inferred key when no flags / env overrides are set', () => {
    const got = resolveSilentAccept(FULL_DEFAULTS, {}, {});
    assert.deepEqual(got.sort(), [
      'baseBranch',
      'operatorHandle',
      'owner',
      'repo',
    ]);
  });

  it('excludes keys that have a CLI flag override', () => {
    const got = resolveSilentAccept(
      FULL_DEFAULTS,
      { owner: 'forked', 'base-branch': 'develop' },
      {},
    );
    assert.deepEqual(got.sort(), ['operatorHandle', 'repo']);
  });

  it('excludes keys that have an env-var override', () => {
    const got = resolveSilentAccept(
      FULL_DEFAULTS,
      {},
      { GH_REPO: 'override-repo', GH_OPERATOR_HANDLE: 'env-handle' },
    );
    assert.deepEqual(got.sort(), ['baseBranch', 'owner']);
  });

  it('excludes keys whose inferred default is null or empty', () => {
    const got = resolveSilentAccept(
      { owner: 'acme', repo: null, baseBranch: 'main', operatorHandle: '' },
      {},
      {},
    );
    assert.deepEqual(got.sort(), ['baseBranch', 'owner']);
  });

  it('returns an empty list when nothing was inferred', () => {
    const got = resolveSilentAccept(
      { owner: null, repo: null, baseBranch: null, operatorHandle: null },
      {},
      {},
    );
    assert.deepEqual(got, []);
  });

  it('treats missing defaults object as empty inference', () => {
    const got = resolveSilentAccept(null, {}, {});
    assert.deepEqual(got, []);
  });
});
