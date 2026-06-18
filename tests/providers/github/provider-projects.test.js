/**
 * GitHubProvider facade — projects surface.
 *
 * Tests GitHubProvider's Projects v2 methods (ensureProjectFields,
 * isInsufficientScopes, ensureStatusField) against a mocked global `fetch`
 * — no live API calls. Split from the former root monolith
 * `tests/providers-github.test.js` (Story #4084).
 *
 * Note: ensureProjectViews was removed in Story #4234 (hard cutover — views
 * are no longer created; no compatibility shim).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createTestProvider, GitHubProvider } from './_helpers.js';

// ---------------------------------------------------------------------------
// ensureProjectFields
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureProjectFields()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty results when projectNumber is null', async () => {
    const provider = createTestProvider({ projectNumber: null });
    const result = await provider.ensureProjectFields([
      {
        name: 'Execution',
        type: 'single_select',
        options: ['sequential', 'concurrent'],
      },
    ]);
    assert.deepEqual(result, { created: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// isInsufficientScopes
// ---------------------------------------------------------------------------
describe('GitHubProvider — isInsufficientScopes()', () => {
  it('detects GraphQL INSUFFICIENT_SCOPES error', () => {
    const err = new Error(
      '[GitHubProvider] GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"missing project scope"}]',
    );
    assert.equal(GitHubProvider.isInsufficientScopes(err), true);
  });

  it('detects "Resource not accessible by personal access token"', () => {
    const err = new Error('Resource not accessible by personal access token');
    assert.equal(GitHubProvider.isInsufficientScopes(err), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(
      GitHubProvider.isInsufficientScopes(new Error('404 Not Found')),
      false,
    );
    assert.equal(GitHubProvider.isInsufficientScopes(null), false);
    assert.equal(GitHubProvider.isInsufficientScopes(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// ensureStatusField
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureStatusField()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when projectNumber is not configured', async () => {
    const provider = createTestProvider({ projectNumber: null });
    await assert.rejects(
      provider.ensureStatusField(['Backlog']),
      /projectNumber/,
    );
  });

  it('creates the Status field with all options when missing', async () => {
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);

      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: { id: 'PVT_1', fields: { nodes: [] } },
              },
            },
          }),
          text: async () => '',
        };
      }
      if (body.query.includes('createProjectV2Field')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              createProjectV2Field: {
                projectV2Field: { id: 'FLD_1', name: 'Status' },
              },
            },
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: {} }),
        text: async () => '',
      };
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Backlog', 'Done']);
    assert.equal(result.status, 'created');
    assert.deepEqual(result.added, ['Backlog', 'Done']);
  });

  it('adds only missing options when Status already exists', async () => {
    let updateCall = null;
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: {
                  id: 'PVT_1',
                  fields: {
                    nodes: [
                      {
                        id: 'FLD_1',
                        name: 'Status',
                        options: [
                          { id: 'OPT_A', name: 'Backlog' },
                          { id: 'OPT_B', name: 'Done' },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          }),
          text: async () => '',
        };
      }
      if (body.query.includes('updateProjectV2Field')) {
        updateCall = body;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              updateProjectV2Field: {
                projectV2Field: { id: 'FLD_1', name: 'Status' },
              },
            },
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: {} }),
        text: async () => '',
      };
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField([
      'Backlog',
      'Planning',
      'Done',
    ]);
    assert.equal(result.status, 'updated');
    assert.deepEqual(result.added, ['Planning']);

    // Verify existing option ids were preserved in the merged list.
    const sentOptions = updateCall.variables.options;
    const withIds = sentOptions.filter((o) => o.id);
    assert.equal(withIds.length, 2);
    assert.ok(sentOptions.some((o) => o.name === 'Planning' && !o.id));
  });

  it('returns unchanged when every option already exists', async () => {
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: {
                  id: 'PVT_1',
                  fields: {
                    nodes: [
                      {
                        id: 'FLD_1',
                        name: 'Status',
                        options: [{ id: 'OPT_A', name: 'Done' }],
                      },
                    ],
                  },
                },
              },
            },
          }),
          text: async () => '',
        };
      }
      throw new Error('unexpected call');
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Done']);
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(result.added, []);
  });

  it('returns scopes-missing when INSUFFICIENT_SCOPES surfaces', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        errors: [
          { type: 'INSUFFICIENT_SCOPES', message: 'missing project scope' },
        ],
      }),
      text: async () => '',
    });

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Backlog']);
    assert.equal(result.status, 'scopes-missing');
    assert.deepEqual(result.added, []);
  });
});

// ---------------------------------------------------------------------------
// ensureProjectViews — removed (#4234)
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureProjectViews removed (#4234)', () => {
  it('ensureProjectViews no longer exists on the provider', () => {
    const provider = createTestProvider({ projectNumber: 1 });
    assert.equal(
      typeof provider.ensureProjectViews,
      'undefined',
      'ensureProjectViews was hard-cutover deleted in Story #4234',
    );
  });
});
