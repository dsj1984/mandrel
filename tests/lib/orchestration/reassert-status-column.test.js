import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reassertStatusColumn } from '../../../.agents/scripts/lib/orchestration/reassert-status-column.js';

/**
 * Provider fake that records every GraphQL call and supports the four
 * queries ColumnSync issues:
 *   1. viewer.projectV2(number) → project metadata
 *   2. repository.issue.projectItems → item id
 *   3. updateProjectV2ItemFieldValue → mutation
 * Plus our own getTicket(id) for label-readback.
 *
 * The fake also exposes a `simulateBotOverwrite()` hook so tests can
 * mimic the GitHub `Pull request merged` workflow stomping on Status
 * between the close-time write and the post-merge re-assert.
 */
function makeProvider({
  ticketLabels = {},
  projectNumber = 1,
  projectId = 'PVT_abc',
  statusFieldId = 'STAT_field',
  statusOptions = { 'In Progress': 'OPT_inprog', Done: 'OPT_done' },
  itemIdByTicket = {},
} = {}) {
  const calls = { graphql: [], getTicket: [], statusByItem: {} };
  return {
    owner: 'acme',
    repo: 'widgets',
    projectNumber,
    calls,
    async getTicket(id) {
      calls.getTicket.push(id);
      return { id, labels: ticketLabels[id] ?? [] };
    },
    async graphql(query, vars) {
      calls.graphql.push({ query, vars });
      if (query.includes('viewer') && query.includes('projectV2(number')) {
        return {
          viewer: {
            projectV2: {
              id: projectId,
              field: {
                id: statusFieldId,
                options: Object.entries(statusOptions).map(([name, id]) => ({
                  id,
                  name,
                })),
              },
            },
          },
        };
      }
      if (
        query.includes('repository(owner') &&
        query.includes('issue(number')
      ) {
        const itemId = itemIdByTicket[vars.number];
        return {
          repository: {
            issue: {
              projectItems: {
                nodes: itemId
                  ? [{ id: itemId, project: { id: projectId } }]
                  : [],
              },
            },
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        calls.statusByItem[vars.itemId] = vars.optionId;
        return {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.itemId } },
        };
      }
      throw new Error(`unexpected graphql query: ${query.slice(0, 60)}`);
    },
    simulateBotOverwrite(itemId, optionId) {
      calls.statusByItem[itemId] = optionId;
    },
  };
}

describe('reassertStatusColumn', () => {
  it('reads ticket labels and syncs the canonical column for agent::done', async () => {
    const provider = makeProvider({
      ticketLabels: { 2813: ['type::story', 'agent::done'] },
      itemIdByTicket: { 2813: 'PVTI_abc' },
    });
    const result = await reassertStatusColumn({ provider, ticketId: 2813 });
    assert.equal(result.status, 'synced');
    assert.equal(result.column, 'Done');
    assert.equal(provider.calls.statusByItem.PVTI_abc, 'OPT_done');
  });

  it('post-merge race: re-assert overwrites a simulated bot flip back to In Progress', async () => {
    const provider = makeProvider({
      ticketLabels: { 7: ['agent::done'] },
      itemIdByTicket: { 7: 'PVTI_seven' },
    });
    // Initial close-time write — orchestrator sets Done.
    await reassertStatusColumn({ provider, ticketId: 7 });
    assert.equal(provider.calls.statusByItem.PVTI_seven, 'OPT_done');
    // Bot fires its post-merge workflow 2 minutes later, stomping on Done.
    provider.simulateBotOverwrite('PVTI_seven', 'OPT_inprog');
    assert.equal(provider.calls.statusByItem.PVTI_seven, 'OPT_inprog');
    // Workflow doc step 5.5 re-runs the CLI; the re-assert wins.
    const after = await reassertStatusColumn({ provider, ticketId: 7 });
    assert.equal(after.status, 'synced');
    assert.equal(after.column, 'Done');
    assert.equal(provider.calls.statusByItem.PVTI_seven, 'OPT_done');
  });

  it('skips cleanly when the ticket has no recognised agent:: label', async () => {
    const provider = makeProvider({
      ticketLabels: { 99: ['type::story'] },
    });
    const result = await reassertStatusColumn({ provider, ticketId: 99 });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-matching-label');
    assert.equal(provider.calls.graphql.length, 0);
  });

  it('skips cleanly when the issue is not on the configured project board', async () => {
    const provider = makeProvider({
      ticketLabels: { 5: ['agent::executing'] },
      itemIdByTicket: {}, // no item registered for #5
    });
    const result = await reassertStatusColumn({ provider, ticketId: 5 });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'not-on-project');
  });

  it('rejects bad inputs', async () => {
    await assert.rejects(
      reassertStatusColumn({ provider: {}, ticketId: 1 }),
      /provider with getTicket/,
    );
    await assert.rejects(
      reassertStatusColumn({
        provider: { getTicket: () => null },
        ticketId: 1,
      }),
      /provider with graphql/,
    );
    await assert.rejects(
      reassertStatusColumn({ provider: makeProvider(), ticketId: 0 }),
      /positive integer ticketId/,
    );
  });
});
