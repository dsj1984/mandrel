import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveProjectMeta } from '../../../.agents/scripts/lib/orchestration/project-meta-resolver.js';

/**
 * Build a fake provider whose graphql() resolves each owner scope from a
 * lookup of `{ organization, user, viewer }` → project node (or null), and
 * records every issued query for ordering assertions. A scope value of
 * `'THROW'` makes that rung throw (simulating a NOT_FOUND for the wrong
 * owner type).
 */
function makeProvider(scopes = {}) {
  const calls = [];
  return {
    calls,
    async graphql(query, vars) {
      calls.push({ query, vars });
      for (const root of ['organization', 'user']) {
        if (query.includes(`${root}(login: $owner)`)) {
          const v = scopes[root];
          if (v === 'THROW') throw new Error(`gh-exec: resource not found`);
          return { [root]: v ? { projectV2: v } : null };
        }
      }
      if (query.includes('viewer {')) {
        const v = scopes.viewer;
        if (v === 'THROW') throw new Error('scope missing');
        return { viewer: v ? { projectV2: v } : null };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    },
  };
}

const NODE = { id: 'PROJ', field: { id: 'F', options: [] } };

describe('resolveProjectMeta', () => {
  it('resolves an org-owned board via the organization rung first', async () => {
    const provider = makeProvider({ organization: NODE });
    const node = await resolveProjectMeta({
      provider,
      owner: 'acme-org',
      projectNumber: 1,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    // org resolved → user/viewer never queried
    assert.equal(provider.calls.length, 1);
    assert.ok(provider.calls[0].query.includes('organization(login: $owner)'));
    assert.equal(provider.calls[0].vars.owner, 'acme-org');
    assert.equal(provider.calls[0].vars.number, 1);
  });

  it('falls from organization (NOT_FOUND) to user', async () => {
    const provider = makeProvider({ organization: 'THROW', user: NODE });
    const node = await resolveProjectMeta({
      provider,
      owner: 'a-user',
      projectNumber: 2,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    assert.equal(provider.calls.length, 2);
    assert.ok(provider.calls[1].query.includes('user(login: $owner)'));
  });

  it('falls from organization+user (both null) to viewer', async () => {
    const provider = makeProvider({
      organization: null,
      user: null,
      viewer: NODE,
    });
    const node = await resolveProjectMeta({
      provider,
      owner: 'somebody',
      projectNumber: 3,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    assert.equal(provider.calls.length, 3);
    assert.ok(provider.calls[2].query.includes('viewer {'));
    // viewer rung carries no owner variable
    assert.equal(provider.calls[2].vars.owner, undefined);
    assert.equal(provider.calls[2].vars.number, 3);
  });

  it('queries only the viewer rung when no owner is supplied', async () => {
    const provider = makeProvider({ viewer: NODE });
    const node = await resolveProjectMeta({
      provider,
      owner: null,
      projectNumber: 4,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    assert.equal(provider.calls.length, 1);
    assert.ok(provider.calls[0].query.includes('viewer {'));
  });

  it('returns null when every rung misses', async () => {
    const provider = makeProvider({
      organization: null,
      user: null,
      viewer: null,
    });
    const node = await resolveProjectMeta({
      provider,
      owner: 'ghost',
      projectNumber: 5,
      projectFields: 'id',
    });
    assert.equal(node, null);
    assert.equal(provider.calls.length, 3);
  });

  it('treats a thrown rung as a miss and advances the ladder', async () => {
    const provider = makeProvider({
      organization: 'THROW',
      user: 'THROW',
      viewer: NODE,
    });
    const node = await resolveProjectMeta({
      provider,
      owner: 'noisy',
      projectNumber: 6,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    assert.equal(provider.calls.length, 3);
  });

  it('embeds the caller-supplied projectFields selection in each rung', async () => {
    const provider = makeProvider({ organization: NODE });
    await resolveProjectMeta({
      provider,
      owner: 'acme-org',
      projectNumber: 1,
      projectFields: 'id field(name: "Status") { ... on X { id } }',
    });
    assert.ok(
      provider.calls[0].query.includes('field(name: "Status")'),
      'projectFields selection appears in the query body',
    );
  });

  it('rejects a provider without graphql', async () => {
    await assert.rejects(
      resolveProjectMeta({
        provider: {},
        projectNumber: 1,
        projectFields: 'id',
      }),
      /provider with graphql/,
    );
  });

  it('rejects an empty projectFields selection', async () => {
    await assert.rejects(
      resolveProjectMeta({
        provider: makeProvider(),
        projectNumber: 1,
        projectFields: '',
      }),
      /projectFields selection/,
    );
  });
});
