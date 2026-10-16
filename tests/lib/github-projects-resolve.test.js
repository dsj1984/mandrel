import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Unit tests for the Projects V2 GraphQL shim
 * (`providers/github/projects-v2-graphql.js`). After Story #1358 collapsed
 * the projects.js / graphql.js / graphql-builder.js trio into a single shim,
 * the previously-public `resolveExistingProject` / `lookupOwnerNodeId` /
 * `createProjectForOwner` helpers became inline branches of
 * `resolveOrCreateProject`. This file now pins the public surface (the
 * exported `resolveOrCreateProject` plus the pure `isScopesMissingEnvelope`
 * detector that gates every soft-degrade branch).
 */

import {
  addItemToProject,
  isScopesMissingEnvelope,
  resolveOrCreateProject,
} from '../../.agents/scripts/providers/github/projects-v2-graphql.js';

describe('isScopesMissingEnvelope', () => {
  it('detects { scopesMissing: true }', () => {
    assert.equal(isScopesMissingEnvelope({ scopesMissing: true }), true);
  });

  it('rejects null/undefined and primitive types', () => {
    assert.equal(isScopesMissingEnvelope(null), false);
    assert.equal(isScopesMissingEnvelope(undefined), false);
    assert.equal(isScopesMissingEnvelope('id-123'), false);
    assert.equal(isScopesMissingEnvelope(42), false);
    assert.equal(isScopesMissingEnvelope(true), false);
    assert.equal(isScopesMissingEnvelope(0), false);
    assert.equal(isScopesMissingEnvelope(''), false);
  });

  it('rejects objects without scopesMissing: true', () => {
    assert.equal(isScopesMissingEnvelope({}), false);
    assert.equal(isScopesMissingEnvelope({ scopesMissing: false }), false);
    assert.equal(isScopesMissingEnvelope({ id: 'P_1' }), false);
    assert.equal(isScopesMissingEnvelope({ scopesMissing: 'yes' }), false);
  });
});

describe('resolveOrCreateProject — public surface', () => {
  it('is an exported AsyncFunction', () => {
    assert.equal(typeof resolveOrCreateProject, 'function');
    assert.equal(resolveOrCreateProject.constructor.name, 'AsyncFunction');
  });
});

describe('addItemToProject — scope refusal reaches the caller (Story #5727)', () => {
  /** A ctx whose GraphQL endpoint answers every request with `errors`. */
  function ctxAnswering(errors) {
    const requests = [];
    return {
      requests,
      projectNumber: 3,
      projectOwner: 'acme',
      token: 'test-token',
      state: { projectId: null },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ errors }) };
      },
    };
  }

  it('re-throws an INSUFFICIENT_SCOPES board lookup instead of reading it as "no board"', async () => {
    const ctx = ctxAnswering([
      {
        type: 'INSUFFICIENT_SCOPES',
        message:
          'Your token has not been granted the required scopes to execute this query.',
      },
    ]);
    await assert.rejects(addItemToProject(ctx, 'NODE'), /INSUFFICIENT_SCOPES/);
    assert.equal(ctx.requests.length, 1, 'fails on the first rung');
  });

  it('still treats an owner miss on every rung as a soft no-op', async () => {
    const ctx = ctxAnswering([{ type: 'NOT_FOUND', message: 'nope' }]);
    assert.equal(await addItemToProject(ctx, 'NODE'), undefined);
    assert.equal(ctx.requests.length, 2);
  });
});
