import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addItemToProject,
  ensureProjectFields,
  ensureProjectViews,
  ensureStatusField,
  isInsufficientScopes,
  isScopesMissingEnvelope,
  resolveOrCreateProject,
} from '../../../.agents/scripts/providers/github/projects-v2-graphql.js';

const SCOPES_ERR = new Error(
  'INSUFFICIENT_SCOPES: token missing project scope',
);
const RNA_ERR = new Error('Resource not accessible by personal access token');
const NOT_GRANTED_ERR = new Error(
  'your token has not been granted the required scopes',
);

/**
 * Build a ctx + fake `fetch` that drives the shim. Each call to `fetch` invokes
 * `runGraphqlScript` with the parsed `{ query, variables }` body and the
 * 0-indexed call number; the return value becomes the GraphQL `data` payload.
 * Returning `null` or throwing simulates an error response.
 */
function buildCtx({ runGraphqlScript } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const i = calls.length;
    calls.push({ query: body.query, variables: body.variables });
    try {
      const result =
        typeof runGraphqlScript === 'function'
          ? runGraphqlScript(body.query, body.variables, i)
          : (runGraphqlScript?.[i] ?? {});
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: result };
        },
        async text() {
          return '';
        },
      };
    } catch (err) {
      // GraphQL surface treats a thrown scoped error as a 200 with errors[].
      const message = err?.message ?? String(err);
      return {
        ok: true,
        status: 200,
        async json() {
          return { errors: [{ message }] };
        },
        async text() {
          return message;
        },
      };
    }
  };
  const ctx = {
    owner: 'acme',
    repo: 'svc',
    projectOwner: 'acme',
    projectNumber: 5,
    projectName: 'Test',
    state: {},
    token: 'fake-token',
    fetchImpl,
  };
  return { ctx, calls };
}

describe('isInsufficientScopes', () => {
  it('matches the canonical INSUFFICIENT_SCOPES message', () => {
    assert.equal(isInsufficientScopes(SCOPES_ERR), true);
  });

  it('matches the "Resource not accessible" REST envelope', () => {
    assert.equal(isInsufficientScopes(RNA_ERR), true);
  });

  it('matches the "not been granted the required scopes" variant', () => {
    assert.equal(isInsufficientScopes(NOT_GRANTED_ERR), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(isInsufficientScopes(new Error('rate limit')), false);
  });

  it('returns false for null / undefined', () => {
    assert.equal(isInsufficientScopes(null), false);
    assert.equal(isInsufficientScopes(undefined), false);
  });

  it('falls back to .toString() / String(err) when no .message is present', () => {
    const objErr = {
      toString() {
        return 'INSUFFICIENT_SCOPES somewhere';
      },
    };
    assert.equal(isInsufficientScopes(objErr), true);
  });
});

describe('isScopesMissingEnvelope', () => {
  it('detects the soft-degrade envelope shape', () => {
    assert.equal(isScopesMissingEnvelope({ scopesMissing: true }), true);
  });

  it('rejects null / non-object / no flag', () => {
    assert.equal(isScopesMissingEnvelope(null), false);
    assert.equal(isScopesMissingEnvelope({}), false);
    assert.equal(isScopesMissingEnvelope({ scopesMissing: false }), false);
    assert.equal(isScopesMissingEnvelope('scopes'), false);
  });
});

describe('resolveOrCreateProject', () => {
  it('returns project envelope on user-scope hit', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => ({ user: { projectV2: { id: 'pv2_123' } } }),
    });
    const result = await resolveOrCreateProject(ctx);
    assert.deepEqual(result, {
      projectId: 'pv2_123',
      projectNumber: 5,
      created: false,
    });
    assert.equal(ctx.state.projectId, 'pv2_123');
  });

  it('falls through to org-scope when user-scope returns no project', async () => {
    const { ctx, calls } = buildCtx({
      runGraphqlScript: (_q, _v, i) =>
        i === 0
          ? { user: null }
          : { organization: { projectV2: { id: 'pv2_org' } } },
    });
    const result = await resolveOrCreateProject(ctx);
    assert.equal(result.projectId, 'pv2_org');
    assert.equal(calls.length, 2);
  });

  it('returns { scopesMissing: true } when creating a new project without scope', async () => {
    // projectNumber unset → falls into the createProject branch where the
    // owner-lookup throws a scopes error and the soft-degrade envelope is
    // returned. The projectNumber-set branch relies on the soft `fetchProjectV2`
    // path swallowing scope errors and surfacing "Project not found" instead
    // (preserved verbatim from the pre-shim behaviour).
    const { ctx } = buildCtx({
      runGraphqlScript: () => {
        throw SCOPES_ERR;
      },
    });
    ctx.projectNumber = null;
    const result = await resolveOrCreateProject(ctx);
    assert.deepEqual(result, { scopesMissing: true });
  });

  it('throws when projectNumber is set but project is not found', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => ({ user: null }),
    });
    // Both user and org lookups return null projectV2 → throws.
    await assert.rejects(
      () => resolveOrCreateProject(ctx),
      /Project #5 not found/,
    );
  });
});

describe('ensureStatusField', () => {
  it('throws when projectNumber is missing', async () => {
    const { ctx } = buildCtx();
    ctx.projectNumber = null;
    await assert.rejects(
      () => ensureStatusField(ctx, ['Todo']),
      /requires projectNumber/,
    );
  });

  it('returns scopes-missing when lookup throws scopes error', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => {
        throw SCOPES_ERR;
      },
    });
    const result = await ensureStatusField(ctx, ['Todo', 'Done']);
    assert.deepEqual(result, { status: 'scopes-missing', added: [] });
  });

  it('returns unchanged when the Status field already has every option', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => ({
        user: {
          projectV2: {
            id: 'pv2',
            fields: {
              nodes: [
                {
                  id: 'f1',
                  name: 'Status',
                  options: [
                    { id: 'o1', name: 'Todo' },
                    { id: 'o2', name: 'Done' },
                  ],
                },
              ],
            },
          },
        },
      }),
    });
    const result = await ensureStatusField(ctx, ['Todo', 'Done']);
    assert.equal(result.status, 'unchanged');
    assert.equal(result.fieldId, 'f1');
  });

  it("returns 'updated' and adds the missing options", async () => {
    let createdCount = 0;
    const { ctx } = buildCtx({
      runGraphqlScript: (_q, _v, i) => {
        if (i === 0)
          return {
            user: {
              projectV2: {
                id: 'pv2',
                fields: {
                  nodes: [
                    {
                      id: 'f1',
                      name: 'Status',
                      options: [{ id: 'o1', name: 'Todo' }],
                    },
                  ],
                },
              },
            },
          };
        createdCount += 1;
        return {};
      },
    });
    const result = await ensureStatusField(ctx, ['Todo', 'Doing', 'Done']);
    assert.equal(result.status, 'updated');
    assert.deepEqual(result.added, ['Doing', 'Done']);
    assert.equal(createdCount, 1);
  });

  it("returns 'created' when the Status field is absent and create succeeds", async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: (_q, _v, i) => {
        if (i === 0) {
          return {
            user: { projectV2: { id: 'pv2', fields: { nodes: [] } } },
          };
        }
        return {
          createProjectV2Field: { projectV2Field: { id: 'newf' } },
        };
      },
    });
    const result = await ensureStatusField(ctx, ['Todo']);
    assert.equal(result.status, 'created');
    assert.equal(result.fieldId, 'newf');
    assert.deepEqual(result.added, ['Todo']);
  });
});

describe('ensureProjectViews', () => {
  it('throws when projectNumber is missing', async () => {
    const { ctx } = buildCtx();
    ctx.projectNumber = null;
    await assert.rejects(
      () => ensureProjectViews(ctx, []),
      /requires projectNumber/,
    );
  });

  it('returns unavailable on fetch failure (scopes missing)', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => {
        throw SCOPES_ERR;
      },
    });
    const result = await ensureProjectViews(ctx, [{ name: 'Backlog' }]);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.skipped, ['Backlog']);
  });

  it('skips views that already exist and creates only the new ones', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: (_q, _v, i) => {
        if (i === 0) {
          return {
            user: {
              projectV2: {
                id: 'pv2',
                views: { nodes: [{ name: 'Backlog' }] },
              },
            },
          };
        }
        return {};
      },
    });
    const result = await ensureProjectViews(ctx, [
      { name: 'Backlog' },
      { name: 'Active', filter: 'is:open' },
    ]);
    assert.deepEqual(result.created, ['Active']);
    assert.deepEqual(result.skipped, ['Backlog']);
    assert.equal(result.unavailable, false);
  });

  it('flips unavailable=true after the first create failure and skips the rest', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: (_q, _v, i) => {
        if (i === 0) {
          return {
            user: { projectV2: { id: 'pv2', views: { nodes: [] } } },
          };
        }
        // first create call (i=1) fails; subsequent should not be invoked
        throw new Error('mutation unavailable');
      },
    });
    const result = await ensureProjectViews(ctx, [
      { name: 'A' },
      { name: 'B' },
    ]);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, ['A', 'B']);
  });

  it('throws when fetched project is null (project not found)', async () => {
    const { ctx } = buildCtx({
      runGraphqlScript: () => ({ user: null }),
    });
    // Two calls: user lookup returns null, org lookup returns no projectV2 →
    // null project.
    await assert.rejects(
      () => ensureProjectViews(ctx, [{ name: 'A' }]),
      /Project #5 not found/,
    );
  });
});

describe('ensureProjectFields', () => {
  it('returns empty when projectNumber is unset', async () => {
    const { ctx } = buildCtx();
    ctx.projectNumber = null;
    const result = await ensureProjectFields(ctx, [
      { name: 'Priority', type: 'single_select', options: ['P0', 'P1'] },
    ]);
    assert.deepEqual(result, { created: [], skipped: [] });
  });

  it('throws when fetched project is null (project not found)', async () => {
    const { ctx } = buildCtx({ runGraphqlScript: () => ({ user: null }) });
    await assert.rejects(
      () => ensureProjectFields(ctx, []),
      /Project #5 not found/,
    );
  });

  it('skips existing fields and iteration-typed fields; creates new single_select fields', async () => {
    let created = 0;
    const { ctx } = buildCtx({
      runGraphqlScript: (_q, _v, i) => {
        if (i === 0) {
          return {
            user: {
              projectV2: {
                id: 'pv2',
                fields: { nodes: [{ name: 'Priority' }] },
              },
            },
          };
        }
        created += 1;
        return {};
      },
    });
    const result = await ensureProjectFields(ctx, [
      { name: 'Priority', type: 'single_select', options: ['P0', 'P1'] },
      { name: 'Sprint', type: 'iteration' },
      { name: 'Risk', type: 'single_select', options: ['Low', 'High'] },
    ]);
    assert.deepEqual(result.created, ['Risk']);
    assert.deepEqual(result.skipped, ['Priority', 'Sprint']);
    assert.equal(created, 1);
  });
});

describe('addItemToProject', () => {
  it('no-ops when projectNumber unset and no projectId cached', async () => {
    const { ctx, calls } = buildCtx();
    ctx.projectNumber = null;
    await addItemToProject(ctx, 'node-123');
    assert.equal(calls.length, 0);
  });

  it('looks up the project, caches the id, and posts addProjectV2ItemById', async () => {
    const { ctx, calls } = buildCtx({
      runGraphqlScript: (_q, _v, i) =>
        i === 0
          ? { user: { projectV2: { id: 'pv2_cached' } } }
          : { addProjectV2ItemById: { item: { id: 'item-1' } } },
    });
    await addItemToProject(ctx, 'node-abc');
    assert.equal(ctx.state.projectId, 'pv2_cached');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].variables, {
      projectId: 'pv2_cached',
      contentId: 'node-abc',
    });
  });

  it('reuses a cached projectId without re-looking up', async () => {
    const { ctx, calls } = buildCtx({
      runGraphqlScript: () => ({
        addProjectV2ItemById: { item: { id: 'item-2' } },
      }),
    });
    ctx.state.projectId = 'pv2_pinned';
    await addItemToProject(ctx, 'node-xyz');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].variables, {
      projectId: 'pv2_pinned',
      contentId: 'node-xyz',
    });
  });
});
