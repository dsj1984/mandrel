import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ColumnSync,
  columnForLabels,
} from '../../../.agents/scripts/lib/orchestration/column-sync.js';

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
    assert.equal(columnForLabels(['type::epic']), null);
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
    const sync = new ColumnSync({ provider });
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
    const sync = new ColumnSync({ provider, projectNumber: null });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'no-project');
  });

  it('no-ops when the label has no column mapping', async () => {
    const provider = providerWithProject();
    const sync = new ColumnSync({ provider });
    const res = await sync.sync(321, ['type::epic']);
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
    const sync = new ColumnSync({ provider });
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
    const sync = new ColumnSync({ provider, logger: { warn: () => {} } });
    await assert.rejects(() => sync.sync(321, ['agent::done']), /API boom/);
  });

  it('looks up the project item by issue → projectItems (no pagination cliff)', async () => {
    // Regression for the >100-item project bug. The previous implementation
    // paginated `node(projectId).items(first: 100)` which silently no-oped
    // for any issue beyond the first 100 board items. The fix walks from
    // the issue to its projectItems and picks the match by project.id.
    const provider = providerWithProject();
    const sync = new ColumnSync({ provider });
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
    const sync = new ColumnSync({ provider });
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
    const sync = new ColumnSync({ provider });
    const res = await sync.sync(321, ['agent::executing']);
    assert.equal(res.status, 'skipped');
    assert.equal(res.reason, 'not-on-project');
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
    const sync = new ColumnSync({
      provider: readProvider({ statusByItem: { PVTI_n: 'Done' } }),
    });
    assert.equal(await sync.readCurrentColumn(7), 'Done');
  });

  it('returns null when the field has no current value', async () => {
    const sync = new ColumnSync({
      provider: readProvider({ statusByItem: {} }),
    });
    assert.equal(await sync.readCurrentColumn(7), null);
  });

  it('returns null when projectNumber is unset', async () => {
    const provider = readProvider({ statusByItem: { PVTI_n: 'Done' } });
    provider.projectNumber = null;
    const sync = new ColumnSync({ provider });
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
    const sync = new ColumnSync({
      provider: baseProvider,
      logger: { info: () => {}, warn: (m) => warned.push(m) },
    });
    const result = await sync.readCurrentColumn(7);
    assert.equal(result, null);
    assert.ok(warned.some((m) => /could not read current Status/.test(m)));
  });
});
