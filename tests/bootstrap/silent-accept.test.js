/**
 * silent-accept.test — Story #2121
 *
 * Exercises `resolveSilentAccept` from bootstrap.js: which keys can be
 * auto-accepted from inferred git defaults without prompting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQuestions,
  resolveSilentAccept,
} from '../../.agents/scripts/bootstrap.js';
import { collectAnswers } from '../../.agents/scripts/lib/bootstrap/prompt.js';

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

// Story #5584 — a non-interactive run never creates a board from the repo name.
describe('buildQuestions projectNumber default', () => {
  const projectQ = (defaults, flags, opts) =>
    buildQuestions(defaults, flags, {}, {}, opts).find(
      (q) => q.key === 'projectNumber',
    );
  const DEFAULTS = { owner: 'acme', repo: 'widget', baseBranch: 'main' };

  it('defaults to skip under --assume-yes with no stored number', () => {
    assert.equal(projectQ(DEFAULTS, { 'assume-yes': true }).default, null);
  });

  it('defaults to skip when the caller reports a non-interactive run', () => {
    assert.equal(projectQ(DEFAULTS, {}, { interactive: false }).default, null);
  });

  it('keeps a stored number non-interactively so a re-run keeps its board', () => {
    const q = projectQ(
      { ...DEFAULTS, projectNumber: '12' },
      {
        'assume-yes': true,
      },
    );
    assert.equal(q.default, '12');
  });

  it('keeps the repo-name default interactively', () => {
    assert.equal(
      projectQ(DEFAULTS, {}, { interactive: true }).default,
      'widget',
    );
    assert.equal(projectQ(DEFAULTS, {}).default, 'widget');
  });

  it('carries the --no-project skip flag', () => {
    assert.equal(projectQ(DEFAULTS, {}).skipFlag, 'no-project');
  });

  it('resolves no board non-interactively, but an explicit name selects one', async () => {
    const run = (flags) =>
      collectAnswers({
        questions: buildQuestions(DEFAULTS, flags, {}, {}),
        flags,
        interactive: false,
        assumeYes: true,
        silentAccept: ['owner', 'repo', 'baseBranch'],
        env: {},
        output: { write: () => {} },
      });
    const skipped = await run({ 'assume-yes': true });
    assert.equal(skipped.answers.projectNumber ?? '', '');
    const named = await run({ 'assume-yes': true, 'project-number': 'Road' });
    assert.equal(named.answers.projectNumber, 'Road');
  });
});
