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
