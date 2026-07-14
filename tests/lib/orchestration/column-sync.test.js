import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ColumnSync,
  columnForLabels,
} from '../../../.agents/scripts/lib/orchestration/column-sync.js';

// Story #4252 — ColumnSync now persists resolved board metadata to an
// on-disk cache under the resolved `tempRoot`. Give every ColumnSync in this
// suite an isolated, per-test tempRoot so that cache (a) never bleeds across
// cases or test runs and (b) never writes into the repo's real `temp/`. The
// `config` bag is shaped like the resolved config (`project.paths.tempRoot`);
// an absolute path is honoured verbatim by the temp-paths anchor.
let _testTempDir;
let _testConfig;
beforeEach(() => {
  _testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandrel-cs-cache-'));
  _testConfig = { project: { paths: { tempRoot: _testTempDir } } };
});
afterEach(() => {
  if (_testTempDir) fs.rmSync(_testTempDir, { recursive: true, force: true });
});

/**
 * Construct a ColumnSync with the per-test isolated tempRoot config merged
 * in, so the disk cache is sandboxed. Tests pass the same `opts` they always
 * have; `config` is injected unless a test overrides it explicitly.
 */
function makeSync(opts) {
  return new ColumnSync({ config: _testConfig, ...opts });
}

describe('columnForLabels', () => {
  it('maps agent lifecycle labels to the three stock columns', () => {
    assert.equal(columnForLabels(['agent::executing']), 'In Progress');
    assert.equal(columnForLabels(['agent::closing']), 'In Progress');
    assert.equal(columnForLabels(['agent::blocked']), 'In Progress');
    assert.equal(columnForLabels(['agent::done']), 'Done');
  });

  it('collapses the parking planning-phase labels onto Todo', () => {
    assert.equal(columnForLabels(['agent::review-spec']), 'Todo');
    assert.equal(columnForLabels(['agent::ready']), 'Todo');
  });

  it('done beats every other state; in-flight beats parking', () => {
    // executing + blocked → In Progress (both collapse to the same bucket)
    assert.equal(
      columnForLabels(['agent::executing', 'agent::blocked']),
      'In Progress',
    );
    // executing + done → Done (terminal wins)
    assert.equal(columnForLabels(['agent::executing', 'agent::done']), 'Done');
    // ready + executing → In Progress (in-flight outranks parking at the
    // board level even though the label set retains both signals)
    assert.equal(
      columnForLabels(['agent::ready', 'agent::executing']),
      'In Progress',
    );
    // done beats every parking-phase label
    assert.equal(columnForLabels(['agent::ready', 'agent::done']), 'Done');
  });

  it('returns null for labels with no mapping', () => {
    assert.equal(columnForLabels(['area::docs']), null);
    assert.equal(columnForLabels(['agent::planning']), null);
    assert.equal(columnForLabels(['agent::dispatching']), null);
    assert.equal(columnForLabels([]), null);
  });
});

function providerWithProject() {
  const graphqlCalls = [];
  const provider = {
    graphqlCalls,
    projectNumber: 42,
    owner: 'acme',
    repo: 'widgets',
    async graphql(query, vars) {
      graphqlCalls.push({ query, vars });
      if (query.includes('viewer {')) {
        return {
          viewer: {
            projectV2: {
              id: 'PROJ',
              field: {
                id: 'FIELD',
                options: [
                  { id: 'opt-todo', name: 'Todo' },
                  { id: 'opt-inprog', name: 'In Progress' },
                  { id: 'opt-done', name: 'Done' },
                ],
              },
            },
          },
        };
      }
      if (query.includes('projectItems(first')) {
        // By-issue lookup. The fake returns two project memberships and
        // expects the matcher to pick the one whose project.id matches
        // the configured board ('PROJ').
        return {
          repository: {
            issue: {
              projectItems: {
                nodes: [
                  { id: 'ITEM-OTHER', project: { id: 'OTHER-PROJ' } },
                  { id: 'ITEM-1', project: { id: 'PROJ' } },
                ],
              },
            },
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        return {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.itemId } },
        };
      }
      return {};
    },
  };
  return provider;
}

describe('ColumnSync.sync', () => {
  it('syncs to the computed column via GraphQL when project is configured', async () => {
    const provider = providerWithProject();
    const sync = makeSync({ provider });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'In Progress');

    const mutation = provider.graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.ok(mutation, 'issued the update mutation');
    assert.equal(mutation.vars.projectId, 'PROJ');
    assert.equal(mutation.vars.itemId, 'ITEM-1');
    assert.equal(mutation.vars.fieldId, 'FIELD');
    assert.equal(mutation.vars.optionId, 'opt-inprog');
  });

  it('no-ops when projectNumber is absent', async () => {
    const provider = { graphql: async () => ({}) };
    const sync = makeSync({ provider, projectNumber: null });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'no-project');
  });

  it('no-ops when the label has no column mapping', async () => {
    const provider = providerWithProject();
    const sync = makeSync({ provider });
    const res = await sync.sync(321, ['area::docs']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'no-matching-label');
  });

  it('degrades gracefully when the Status field is missing', async () => {
    const provider = {
      projectNumber: 42,
      async graphql() {
        return { viewer: { projectV2: { id: 'PROJ', field: null } } };
      },
    };
    const sync = makeSync({ provider });
    const res = await sync.sync(321, ['agent::done']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'no-meta');
  });

  it('propagates errors from the update mutation (fail loud)', async () => {
    const provider = {
      projectNumber: 42,
      owner: 'acme',
      repo: 'widgets',
      async graphql(query) {
        if (query.includes('viewer {')) {
          return {
            viewer: {
              projectV2: {
                id: 'PROJ',
                field: {
                  id: 'F',
                  options: [{ id: 'opt-done', name: 'Done' }],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM', project: { id: 'PROJ' } }],
                },
              },
            },
          };
        }
        throw new Error('API boom');
      },
    };
    const sync = makeSync({ provider, logger: { warn: () => {} } });
    await assert.rejects(() => sync.sync(321, ['agent::done']), /API boom/);
  });

  it('looks up the project item by issue → projectItems (no pagination cliff)', async () => {
    // Regression for the >100-item project bug. The previous implementation
    // paginated `node(projectId).items(first: 100)` which silently no-oped
    // for any issue beyond the first 100 board items. The fix walks from
    // the issue to its projectItems and picks the match by project.id.
    const provider = providerWithProject();
    const sync = makeSync({ provider });
    const res = await sync.sync(2586, ['agent::executing']);

    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'In Progress');

    const lookup = provider.graphqlCalls.find((c) =>
      c.query.includes('projectItems(first'),
    );
    assert.ok(lookup, 'used the by-issue projectItems lookup');
    assert.equal(lookup.vars.owner, 'acme');
    assert.equal(lookup.vars.repo, 'widgets');
    assert.equal(lookup.vars.number, 2586);

    const oldLookup = provider.graphqlCalls.find(
      (c) =>
        c.query.includes('items(first') &&
        !c.query.includes('projectItems(first'),
    );
    assert.equal(
      oldLookup,
      undefined,
      'no longer issues the bulk items(first: 100) scan',
    );

    const mutation = provider.graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(
      mutation.vars.itemId,
      'ITEM-1',
      'selects the projectItem whose project.id matches the configured board',
    );
  });

  it('skips when the issue is not on the configured project', async () => {
    const provider = {
      projectNumber: 42,
      owner: 'acme',
      repo: 'widgets',
      async graphql(query) {
        if (query.includes('viewer {')) {
          return {
            viewer: {
              projectV2: {
                id: 'PROJ',
                field: {
                  id: 'F',
                  options: [{ id: 'opt-inprog', name: 'In Progress' }],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          // The issue is on a different project, not 'PROJ'.
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ELSEWHERE', project: { id: 'OTHER' } }],
                },
              },
            },
          };
        }
        return {};
      },
    };
    const sync = makeSync({ provider });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'not-on-project');
  });

  it('skips when the provider has no owner/repo configured', async () => {
    const provider = {
      projectNumber: 42,
      async graphql(query) {
        if (query.includes('viewer {')) {
          return {
            viewer: {
              projectV2: {
                id: 'PROJ',
                field: {
                  id: 'F',
                  options: [{ id: 'opt-inprog', name: 'In Progress' }],
                },
              },
            },
          };
        }
        return {};
      },
    };
    const sync = makeSync({ provider });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'not-on-project');
  });

  it('uses user(login: $owner) query when projectOwner differs from viewer (Story #3560)', async () => {
    // Simulates the cross-owner scenario: operator authenticated as
    // 'chrisbarrantes' but project is owned by 'dsj1984'. viewer.projectV2
    // would return null; user(login: 'dsj1984').projectV2 returns the board.
    const graphqlCalls = [];
    const provider = {
      graphqlCalls,
      projectNumber: 1,
      projectOwner: 'dsj1984',
      owner: 'dsj1984',
      repo: 'mandrel',
      async graphql(query, vars) {
        graphqlCalls.push({ query, vars });
        if (query.includes('user(login: $owner)')) {
          return {
            user: {
              projectV2: {
                id: 'PROJ-CROSS',
                field: {
                  id: 'FIELD-CROSS',
                  options: [
                    { id: 'opt-todo', name: 'Todo' },
                    { id: 'opt-inprog', name: 'In Progress' },
                    { id: 'opt-done', name: 'Done' },
                  ],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM-CROSS', project: { id: 'PROJ-CROSS' } }],
                },
              },
            },
          };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: vars.itemId },
            },
          };
        }
        return {};
      },
    };

    const sync = makeSync({ provider });
    const res = await sync.sync(100, ['agent::done']);
    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'Done');

    // Confirm the cross-owner query was issued (not the viewer query)
    const metaCall = graphqlCalls.find((c) =>
      c.query.includes('user(login: $owner)'),
    );
    assert.ok(metaCall, 'issued the user(login: $owner) query');
    assert.equal(metaCall.vars.owner, 'dsj1984');
    assert.equal(metaCall.vars.number, 1);

    const viewerCall = graphqlCalls.find(
      (c) => c.query.includes('viewer {') && c.query.includes('projectV2'),
    );
    assert.equal(viewerCall, undefined, 'did not fall back to viewer query');

    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.ok(mutation, 'issued the update mutation');
    assert.equal(mutation.vars.projectId, 'PROJ-CROSS');
    assert.equal(mutation.vars.itemId, 'ITEM-CROSS');
    assert.equal(mutation.vars.optionId, 'opt-done');
  });

  it('falls through the owner ladder to viewer when only user/viewer-owned (Story #4237)', async () => {
    // Backward compatibility: when projectOwner is absent, the resolver
    // still walks the owner ladder using the repo owner (organization →
    // user → viewer). For a user/viewer-owned board the org and user
    // rungs miss (null), and resolution falls through to the original
    // viewer.projectV2 path — the historical behaviour is preserved.
    const graphqlCalls = [];
    const provider = {
      graphqlCalls,
      projectNumber: 42,
      // projectOwner deliberately absent
      owner: 'acme',
      repo: 'widgets',
      async graphql(query, vars) {
        graphqlCalls.push({ query, vars });
        // org and user rungs miss for a viewer-owned board
        if (query.includes('organization(login: $owner)')) {
          return { organization: null };
        }
        if (query.includes('user(login: $owner)')) {
          return { user: null };
        }
        if (query.includes('viewer {')) {
          return {
            viewer: {
              projectV2: {
                id: 'PROJ-VIEWER',
                field: {
                  id: 'FIELD-VIEWER',
                  options: [{ id: 'opt-done', name: 'Done' }],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM-V', project: { id: 'PROJ-VIEWER' } }],
                },
              },
            },
          };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: vars.itemId },
            },
          };
        }
        return {};
      },
    };

    const sync = makeSync({ provider });
    const res = await sync.sync(50, ['agent::done']);
    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'Done');

    const viewerCall = graphqlCalls.find(
      (c) => c.query.includes('viewer {') && c.query.includes('projectV2'),
    );
    assert.ok(viewerCall, 'fell through to the viewer query');

    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(mutation.vars.projectId, 'PROJ-VIEWER');
  });

  it('resolves an organization-owned board via organization(login: $owner) (Story #4237)', async () => {
    // The core bug: org-owned boards (github.owner is an org) previously
    // failed with NOT_FOUND because there was no organization() resolution
    // path. The resolver now tries organization(login:$owner) first.
    const graphqlCalls = [];
    const provider = {
      graphqlCalls,
      projectNumber: 1,
      // No explicit projectOwner — owner is the org login itself.
      owner: 'Beestera',
      repo: 'swarm-os',
      async graphql(query, vars) {
        graphqlCalls.push({ query, vars });
        if (query.includes('organization(login: $owner)')) {
          return {
            organization: {
              projectV2: {
                id: 'PROJ-ORG',
                field: {
                  id: 'FIELD-ORG',
                  options: [
                    { id: 'opt-todo', name: 'Todo' },
                    { id: 'opt-inprog', name: 'In Progress' },
                    { id: 'opt-done', name: 'Done' },
                  ],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM-ORG', project: { id: 'PROJ-ORG' } }],
                },
              },
            },
          };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: vars.itemId },
            },
          };
        }
        return {};
      },
    };

    const sync = makeSync({ provider });
    const res = await sync.sync(2, ['agent::executing']);
    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'In Progress');

    const orgCall = graphqlCalls.find((c) =>
      c.query.includes('organization(login: $owner)'),
    );
    assert.ok(orgCall, 'issued the organization(login: $owner) query');
    assert.equal(orgCall.vars.owner, 'Beestera');
    assert.equal(orgCall.vars.number, 1);

    // Org rung resolved → user/viewer rungs must NOT be probed.
    const userCall = graphqlCalls.find((c) =>
      c.query.includes('user(login: $owner)'),
    );
    assert.equal(userCall, undefined, 'did not fall through to user rung');
    const viewerCall = graphqlCalls.find(
      (c) => c.query.includes('viewer {') && c.query.includes('projectV2'),
    );
    assert.equal(viewerCall, undefined, 'did not fall through to viewer rung');

    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(mutation.vars.projectId, 'PROJ-ORG');
    assert.equal(mutation.vars.optionId, 'opt-inprog');
  });

  it('falls from organization (NOT_FOUND) to user(login: $owner) for a user board (Story #4237)', async () => {
    // A user-owned board where the owner login is not an org: the
    // organization rung throws NOT_FOUND, and the resolver advances to the
    // user rung rather than aborting.
    const graphqlCalls = [];
    const provider = {
      graphqlCalls,
      projectNumber: 1,
      projectOwner: 'dsj1984',
      owner: 'dsj1984',
      repo: 'mandrel',
      async graphql(query, vars) {
        graphqlCalls.push({ query, vars });
        if (query.includes('organization(login: $owner)')) {
          throw new Error('gh-exec: resource not found');
        }
        if (query.includes('user(login: $owner)')) {
          return {
            user: {
              projectV2: {
                id: 'PROJ-USER',
                field: {
                  id: 'FIELD-USER',
                  options: [{ id: 'opt-done', name: 'Done' }],
                },
              },
            },
          };
        }
        if (query.includes('projectItems(first')) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'ITEM-USER', project: { id: 'PROJ-USER' } }],
                },
              },
            },
          };
        }
        if (query.includes('updateProjectV2ItemFieldValue')) {
          return {
            updateProjectV2ItemFieldValue: {
              projectV2Item: { id: vars.itemId },
            },
          };
        }
        return {};
      },
    };

    const sync = makeSync({ provider });
    const res = await sync.sync(7, ['agent::done']);
    assert.equal(res.status, 'synced');
    assert.equal(res.column, 'Done');

    const orgCall = graphqlCalls.find((c) =>
      c.query.includes('organization(login: $owner)'),
    );
    assert.ok(orgCall, 'attempted the organization rung first');
    const userCall = graphqlCalls.find((c) =>
      c.query.includes('user(login: $owner)'),
    );
    assert.ok(userCall, 'advanced to the user rung after org NOT_FOUND');

    const mutation = graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(mutation.vars.projectId, 'PROJ-USER');
  });
});

describe('ColumnSync.readCurrentColumn (Story #2876)', () => {
  function readProvider({ statusByItem, projectId = 'PVT_x' }) {
    return {
      owner: 'acme',
      repo: 'widgets',
      projectNumber: 1,
      async graphql(query, vars) {
        if (query.includes('viewer') && query.includes('projectV2(number')) {
          return {
            viewer: {
              projectV2: {
                id: projectId,
                field: {
                  id: 'STAT_field',
                  options: [
                    { id: 'OPT_inprog', name: 'In Progress' },
                    { id: 'OPT_done', name: 'Done' },
                  ],
                },
              },
            },
          };
        }
        if (
          query.includes('repository(owner') &&
          query.includes('issue(number')
        ) {
          return {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: 'PVTI_n', project: { id: projectId } }],
                },
              },
            },
          };
        }
        if (query.includes('fieldValueByName')) {
          const name = statusByItem[vars.itemId] ?? null;
          return { node: { fieldValueByName: name ? { name } : null } };
        }
        throw new Error('unexpected');
      },
    };
  }

  it('returns the live column name when set', async () => {
    const sync = makeSync({
      provider: readProvider({ statusByItem: { PVTI_n: 'Done' } }),
    });
    assert.equal(await sync.readCurrentColumn(7), 'Done');
  });

  it('returns null when the field has no current value', async () => {
    const sync = makeSync({
      provider: readProvider({ statusByItem: {} }),
    });
    assert.equal(await sync.readCurrentColumn(7), null);
  });

  it('returns null when projectNumber is unset', async () => {
    const provider = readProvider({ statusByItem: { PVTI_n: 'Done' } });
    provider.projectNumber = null;
    const sync = makeSync({ provider });
    assert.equal(await sync.readCurrentColumn(7), null);
  });

  it('returns null and logs when the live-Status graphql throws', async () => {
    const warned = [];
    const baseProvider = readProvider({ statusByItem: {} });
    const origGraphql = baseProvider.graphql.bind(baseProvider);
    baseProvider.graphql = async (query, vars) => {
      if (query.includes('fieldValueByName')) {
        throw new Error('boom');
      }
      return origGraphql(query, vars);
    };
    const sync = makeSync({
      provider: baseProvider,
      logger: { info: () => {}, warn: (m) => warned.push(m) },
    });
    const result = await sync.readCurrentColumn(7);
    assert.equal(result, null);
    assert.ok(warned.some((m) => /could not read current Status/.test(m)));
  });
});
