/**
 * Unit tests for `.agents/scripts/providers/github/errors.js`.
 *
 * Covers all four classification branches that `classifyGithubError`
 * routes through (feature-disabled, permission, transient, permanent),
 * plus a public-surface check that the parent module still re-exports
 * the four named symbols.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const errorsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'errors.js'),
  ).href
);
const providerMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);

const {
  classifyGithubError,
  SUB_ISSUES_QUERY,
  ADD_SUB_ISSUE_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
} = errorsMod;

describe('providers/github/errors.js — classifyGithubError', () => {
  it('feature-disabled branch: subissues field-not-available message', () => {
    assert.strictEqual(
      classifyGithubError(new Error('feature not available')),
      'feature-disabled',
    );
    assert.strictEqual(
      classifyGithubError(new Error("field 'subIssues' doesn't exist on type")),
      'feature-disabled',
    );
  });

  it('transient branch: 5xx / 429 / rate-limit / network codes', () => {
    assert.strictEqual(
      classifyGithubError({ message: 'server boom', status: 503 }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'too many', status: 429 }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'network', code: 'ECONNRESET' }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'secondary rate limit hit' }),
      'transient',
    );
    // Rate-limit-via-403 is transient, not permission — regression guard.
    assert.strictEqual(
      classifyGithubError({ message: 'secondary rate limit', status: 403 }),
      'transient',
    );
  });

  it('permission branch: 401 / 403 / unauthorized / forbidden messages', () => {
    assert.strictEqual(
      classifyGithubError({ message: 'Unauthorized', status: 401 }),
      'permission',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'Forbidden', status: 403 }),
      'permission',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'permission denied' }),
      'permission',
    );
  });

  it('permanent branch: null err and anything that doesn’t match the others', () => {
    assert.strictEqual(classifyGithubError(null), 'permanent');
    assert.strictEqual(
      classifyGithubError({ message: 'some unexpected failure' }),
      'permanent',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'bad request', status: 400 }),
      'permanent',
    );
  });
});

describe('providers/github/errors.js — GraphQL constants', () => {
  it('SUB_ISSUES_QUERY queries the subIssues paginated connection', () => {
    assert.match(SUB_ISSUES_QUERY, /subIssues\(first: 100, after: \$cursor\)/);
    assert.match(SUB_ISSUES_QUERY, /pageInfo \{ hasNextPage endCursor \}/);
  });

  it('ADD_SUB_ISSUE_MUTATION sends parentId/subIssueId/replaceParent', () => {
    assert.match(ADD_SUB_ISSUE_MUTATION, /addSubIssue\(input:/);
    assert.match(ADD_SUB_ISSUE_MUTATION, /\$replaceParent: Boolean/);
  });

  it('REMOVE_SUB_ISSUE_MUTATION sends parentId/subIssueId', () => {
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /removeSubIssue\(input:/);
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /\$parentId: ID!/);
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /\$subIssueId: ID!/);
  });
});

describe('providers/github.js — re-export surface', () => {
  it('parent re-exports the four named symbols unchanged', () => {
    assert.strictEqual(
      providerMod.classifyGithubError,
      classifyGithubError,
      'classifyGithubError identity preserved',
    );
    assert.strictEqual(
      providerMod.SUB_ISSUES_QUERY,
      SUB_ISSUES_QUERY,
      'SUB_ISSUES_QUERY identity preserved',
    );
    assert.strictEqual(
      providerMod.ADD_SUB_ISSUE_MUTATION,
      ADD_SUB_ISSUE_MUTATION,
      'ADD_SUB_ISSUE_MUTATION identity preserved',
    );
    assert.strictEqual(
      providerMod.REMOVE_SUB_ISSUE_MUTATION,
      REMOVE_SUB_ISSUE_MUTATION,
      'REMOVE_SUB_ISSUE_MUTATION identity preserved',
    );
  });
});
