import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify } from '../../../.agents/scripts/lib/gh-exec.js';
import {
  ProjectAccessError,
  resolveProjectMeta,
} from '../../../.agents/scripts/lib/orchestration/project-meta-resolver.js';

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

describe('resolveProjectMeta — error classification (Story #5727)', () => {
  /** A provider whose owner rungs throw the given messages, in ladder order. */
  function throwingProvider(messages, viewer = NODE) {
    const calls = [];
    return {
      calls,
      async graphql(query) {
        calls.push(query);
        for (const root of ['organization', 'user']) {
          if (query.includes(`${root}(login: $owner)`)) {
            const msg = messages[root];
            if (msg) throw new Error(msg);
            return { [root]: null };
          }
        }
        return { viewer: { projectV2: viewer } };
      },
    };
  }

  it('advances the ladder on a GraphQL NOT_FOUND owner miss', async () => {
    const provider = throwingProvider({
      organization:
        '[GitHubProvider] GraphQL errors: [{"type":"NOT_FOUND","message":"Could not resolve to an Organization with the login of \'a-user\'."}]',
    });
    const node = await resolveProjectMeta({
      provider,
      owner: 'a-user',
      projectNumber: 7,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
    assert.equal(provider.calls.length, 3);
  });

  it('fails fast with a ProjectAccessError naming the project scope on INSUFFICIENT_SCOPES', async () => {
    const provider = throwingProvider({
      organization:
        '[GitHubProvider] GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]',
    });
    await assert.rejects(
      resolveProjectMeta({
        provider,
        owner: 'acme',
        projectNumber: 8,
        projectFields: 'id',
      }),
      (err) => {
        assert.ok(err instanceof ProjectAccessError);
        assert.equal(err.scope, 'project');
        assert.equal(err.remedy, 'gh auth refresh -h github.com -s project');
        assert.match(err.cause.message, /INSUFFICIENT_SCOPES/);
        return true;
      },
    );
    assert.equal(provider.calls.length, 1, 'no later rung is tried');
  });

  it('fails fast on a FORBIDDEN / HTTP 403 auth refusal', async () => {
    for (const msg of [
      'GraphQL errors: [{"type":"FORBIDDEN","message":"no"}]',
      '[GitHubProvider] GraphQL 403: forbidden',
    ]) {
      const provider = throwingProvider({ user: msg });
      await assert.rejects(
        resolveProjectMeta({
          provider,
          owner: 'acme',
          projectNumber: 9,
          projectFields: 'id',
        }),
        ProjectAccessError,
      );
      assert.equal(provider.calls.length, 2);
    }
  });

  it('keeps advancing on any other error', async () => {
    const provider = throwingProvider({
      organization: 'socket hang up',
      user: 'gh-exec: timeout',
    });
    const node = await resolveProjectMeta({
      provider,
      owner: 'acme',
      projectNumber: 10,
      projectFields: 'id',
    });
    assert.deepEqual(node, NODE);
  });
});

describe('resolveProjectMeta — gh-exec classified errors (Story #5735)', () => {
  const SCOPE_STDERR =
    "gh: Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project'] (INSUFFICIENT_SCOPES)\n";

  /** A provider whose organization rung throws `err`, as `ghGraphql` would. */
  function ghThrowingProvider(err) {
    const calls = [];
    return {
      calls,
      async graphql(query) {
        calls.push(query);
        if (query.includes('organization(login: $owner)')) throw err;
        if (query.includes('user(login: $owner)')) return { user: null };
        return { viewer: { projectV2: NODE } };
      },
    };
  }

  const ghError = (stderr) =>
    classify({ args: ['api', 'graphql'], stdout: '', stderr, code: 1 });

  it('fails fast with a ProjectAccessError when the scope text is only in stderr', async () => {
    const err = ghError(SCOPE_STDERR);
    assert.equal(err.name, 'GhScopeError');
    assert.doesNotMatch(err.message, /INSUFFICIENT_SCOPES/);
    const provider = ghThrowingProvider(err);
    await assert.rejects(
      resolveProjectMeta({
        provider,
        owner: 'acme',
        projectNumber: 11,
        projectFields: 'id',
      }),
      (thrown) => {
        assert.ok(thrown instanceof ProjectAccessError);
        assert.equal(thrown.cause, err);
        assert.match(thrown.message, /INSUFFICIENT_SCOPES/);
        return true;
      },
    );
    assert.equal(provider.calls.length, 1, 'no later rung is tried');
  });

  it('fails fast when gh leaves an unclassified error carrying INSUFFICIENT_SCOPES in stderr', async () => {
    const err = ghError('gh: GraphQL: INSUFFICIENT_SCOPES\n');
    assert.notEqual(err.name, 'GhScopeError');
    await assert.rejects(
      resolveProjectMeta({
        provider: ghThrowingProvider(err),
        owner: 'acme',
        projectNumber: 12,
        projectFields: 'id',
      }),
      ProjectAccessError,
    );
  });

  it('treats a gh transport failure and a gh NOT_FOUND as rung misses', async () => {
    for (const stderr of [
      'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host\n',
      "gh: Could not resolve to an Organization with the login of 'acme'. (NOT_FOUND)\n",
    ]) {
      const provider = ghThrowingProvider(ghError(stderr));
      const node = await resolveProjectMeta({
        provider,
        owner: 'acme',
        projectNumber: 13,
        projectFields: 'id',
      });
      assert.deepEqual(node, NODE, stderr);
      assert.equal(provider.calls.length, 3);
    }
  });
});
