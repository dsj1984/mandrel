import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reassertStatusColumn } from '../../../.agents/scripts/lib/orchestration/reassert-status-column.js';

/**
 * Provider fake that records every GraphQL call and supports the four
 * queries ColumnSync issues:
 *   1. viewer.projectV2(number) → project metadata
 *   2. repository.issue.projectItems → item id
 *   3. updateProjectV2ItemFieldValue → mutation
 *   4. node(itemId).fieldValueByName("Status") → live column read
 *     (Story #2876 — drift-check path).
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
  // Story #2876 — `onMutation(itemId, optionId, callIndex)` lets a test
  // simulate a bot overwriting the value AFTER the orchestrator's
  // mutation lands. Called with the post-mutation state.
  onMutation,
} = {}) {
  const calls = { graphql: [], getTicket: [], statusByItem: {} };
  let mutationCount = 0;
  const optionIdToName = Object.fromEntries(
    Object.entries(statusOptions).map(([name, id]) => [id, name]),
  );
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
      if (query.includes('fieldValueByName')) {
        const currentOpt = calls.statusByItem[vars.itemId];
        const name = currentOpt ? optionIdToName[currentOpt] : null;
        return {
          node: {
            fieldValueByName: name ? { name } : null,
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        calls.statusByItem[vars.itemId] = vars.optionId;
        mutationCount += 1;
        if (typeof onMutation === 'function') {
          onMutation(vars.itemId, vars.optionId, mutationCount);
        }
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

// Test-only fast sleep so the poll loop runs instantly.
const fastSleep = () => Promise.resolve();

describe('reassertStatusColumn — basics', () => {
  it('syncs the canonical column for agent::done; attempts=1 on sticky outcome', async () => {
    const provider = makeProvider({
      ticketLabels: { 2813: ['type::story', 'agent::done'] },
      itemIdByTicket: { 2813: 'PVTI_abc' },
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 2813,
      sleepFn: fastSleep,
    });
    assert.equal(result.status, 'synced');
    assert.equal(result.column, 'Done');
    assert.equal(result.attempts, 1);
    assert.equal(provider.calls.statusByItem.PVTI_abc, 'OPT_done');
  });

  it('skips cleanly when the ticket has no recognised agent:: label', async () => {
    const provider = makeProvider({
      ticketLabels: { 99: ['type::story'] },
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 99,
      sleepFn: fastSleep,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-matching-label');
    assert.equal(provider.calls.graphql.length, 0);
  });

  it('skips cleanly when the issue is not on the configured project board', async () => {
    const provider = makeProvider({
      ticketLabels: { 5: ['agent::executing'] },
      itemIdByTicket: {}, // no item registered for #5
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 5,
      sleepFn: fastSleep,
    });
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
    await assert.rejects(
      reassertStatusColumn({
        provider: makeProvider(),
        ticketId: 1,
        pollAttempts: 0,
      }),
      /positive integer pollAttempts/,
    );
  });
});

describe('reassertStatusColumn — poll-and-retry loop (Story #2876)', () => {
  it('detects drift after the initial sync and re-fires on the next attempt', async () => {
    let firstMutationDone = false;
    const provider = makeProvider({
      ticketLabels: { 7: ['agent::done'] },
      itemIdByTicket: { 7: 'PVTI_seven' },
      // After the first mutation, simulate a bot flipping back to "In Progress"
      // BEFORE the next drift check.
      onMutation: (itemId, _opt, callIndex) => {
        if (callIndex === 1) {
          // Bot stomps right after our initial write.
          firstMutationDone = true;
          // Mutate the recorded "current state" out-of-band.
          provider.calls.statusByItem[itemId] = 'OPT_inprog';
        }
      },
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 7,
      sleepFn: fastSleep,
    });
    assert.equal(firstMutationDone, true);
    assert.equal(result.status, 'synced');
    assert.equal(result.column, 'Done');
    assert.equal(result.attempts, 2, 'one initial + one re-fire');
    assert.equal(provider.calls.statusByItem.PVTI_seven, 'OPT_done');
  });

  it('returns drifted when a hostile bot keeps overwriting through every attempt', async () => {
    const provider = makeProvider({
      ticketLabels: { 7: ['agent::done'] },
      itemIdByTicket: { 7: 'PVTI_seven' },
      onMutation: (itemId) => {
        // Bot wins every race — flips back immediately after each of our writes.
        provider.calls.statusByItem[itemId] = 'OPT_inprog';
      },
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 7,
      pollAttempts: 3,
      sleepFn: fastSleep,
    });
    assert.equal(result.status, 'drifted');
    assert.equal(result.column, 'Done');
    assert.equal(result.attempts, 3);
  });

  it('short-circuits the poll loop when pollAttempts: 1 (back-compat)', async () => {
    let mutationCount = 0;
    const provider = makeProvider({
      ticketLabels: { 7: ['agent::done'] },
      itemIdByTicket: { 7: 'PVTI_seven' },
      onMutation: () => {
        mutationCount += 1;
      },
    });
    const result = await reassertStatusColumn({
      provider,
      ticketId: 7,
      pollAttempts: 1,
      sleepFn: fastSleep,
    });
    assert.equal(result.status, 'synced');
    assert.equal(result.attempts, 1);
    assert.equal(mutationCount, 1);
  });

  it('the skip paths short-circuit before the poll loop', async () => {
    const provider = makeProvider({
      ticketLabels: { 99: ['type::story'] },
    });
    let sleeps = 0;
    const sleepFn = () => {
      sleeps += 1;
      return Promise.resolve();
    };
    const result = await reassertStatusColumn({
      provider,
      ticketId: 99,
      sleepFn,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(sleeps, 0);
  });

  it('transient drift-check errors are logged and the loop continues', async () => {
    // Simulate a fieldValueByName query that throws once then recovers.
    // ColumnSync swallows the throw internally and returns null; the
    // poll loop reads null as drift and re-fires.
    let drift = 0;
    const baseProvider = makeProvider({
      ticketLabels: { 7: ['agent::done'] },
      itemIdByTicket: { 7: 'PVTI_seven' },
    });
    const origGraphql = baseProvider.graphql.bind(baseProvider);
    baseProvider.graphql = async (query, vars) => {
      if (query.includes('fieldValueByName')) {
        drift += 1;
        if (drift === 1) throw new Error('transient ECONNRESET');
      }
      return origGraphql(query, vars);
    };
    const warned = [];
    const result = await reassertStatusColumn({
      provider: baseProvider,
      ticketId: 7,
      pollAttempts: 3,
      sleepFn: fastSleep,
      logger: {
        info: () => {},
        warn: (m) => warned.push(m),
      },
    });
    // The loop is resilient — final outcome is still synced because the
    // re-fire after the transient drift lands cleanly.
    assert.equal(result.status, 'synced');
    // ColumnSync.readCurrentColumn logs the transient via the warn channel.
    assert.ok(
      warned.some((m) => /could not read current Status/.test(m)),
      `expected a ColumnSync warning in: ${warned.join(' | ')}`,
    );
  });
});
