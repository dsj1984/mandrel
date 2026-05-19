import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ColumnSync,
  columnForLabels,
} from '../../../.agents/scripts/lib/orchestration/column-sync.js';

describe('columnForLabels', () => {
  it('maps agent lifecycle labels to board columns', () => {
    assert.equal(columnForLabels(['agent::executing']), 'In Progress');
    assert.equal(columnForLabels(['agent::blocked']), 'Blocked');
    assert.equal(columnForLabels(['agent::done']), 'Done');
  });

  it('maps the parking planning-phase labels to board columns', () => {
    assert.equal(columnForLabels(['agent::review-spec']), 'Spec Review');
    assert.equal(columnForLabels(['agent::ready']), 'Ready');
  });

  it('prefers the more urgent state when multiple are set', () => {
    // executing + blocked → Blocked (urgency wins)
    assert.equal(
      columnForLabels(['agent::executing', 'agent::blocked']),
      'Blocked',
    );
    // executing + done → Done (terminal beats active)
    assert.equal(columnForLabels(['agent::executing', 'agent::done']), 'Done');
    // ready + executing → Ready (parking outranks execution at the board level)
    assert.equal(
      columnForLabels(['agent::ready', 'agent::executing']),
      'Ready',
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
                  { id: 'opt-inprog', name: 'In Progress' },
                  { id: 'opt-blocked', name: 'Blocked' },
                  { id: 'opt-review', name: 'Review' },
                  { id: 'opt-done', name: 'Done' },
                ],
              },
            },
          },
        };
      }
      if (query.includes('items(first')) {
        return {
          node: {
            items: {
              nodes: [
                { id: 'ITEM-1', content: { number: 321 } },
                { id: 'ITEM-2', content: { number: 400 } },
              ],
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
        if (query.includes('items(first')) {
          return {
            node: {
              items: { nodes: [{ id: 'ITEM', content: { number: 321 } }] },
            },
          };
        }
        throw new Error('API boom');
      },
    };
    const sync = new ColumnSync({ provider, logger: { warn: () => {} } });
    await assert.rejects(() => sync.sync(321, ['agent::done']), /API boom/);
  });
});
