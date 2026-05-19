import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transitionTicketState } from '../../../.agents/scripts/lib/orchestration/ticketing.js';

/**
 * Story #2548 — `transitionTicketState` MUST mirror every label flip
 * onto the Projects v2 Status column via `ColumnSync`. Prior to this
 * Story the sync was only wired from the epic-runner against the Epic
 * ticket; Stories and Tasks never had their `agent::executing` /
 * `agent::blocked` flips reflected on the board.
 *
 * These tests pump a fake provider's `graphql` calls and assert (a) the
 * happy path issues exactly one `updateProjectV2ItemFieldValue` with the
 * option id derived from `LABEL_TO_COLUMN[newState]`, and (b) a thrown
 * graphql error during the column-sync does NOT propagate to the
 * `transitionTicketState` caller — the label flip remains observable.
 */

function buildFakeProvider({ throwOnMutation = false } = {}) {
  const updates = [];
  const graphqlCalls = [];
  let ticketLabels = ['agent::ready'];
  return {
    projectNumber: 42,
    owner: 'acme',
    repo: 'widgets',
    get _labels() {
      return ticketLabels;
    },
    updates,
    graphqlCalls,
    async getTicket() {
      return {
        id: 321,
        title: 'fixture',
        labels: ticketLabels,
        body: '',
      };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
      if (mutations?.labels) {
        const remove = new Set(mutations.labels.remove ?? []);
        const add = mutations.labels.add ?? [];
        ticketLabels = ticketLabels.filter((l) => !remove.has(l));
        for (const l of add) {
          if (!ticketLabels.includes(l)) ticketLabels.push(l);
        }
      }
    },
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
                  { id: 'opt-done', name: 'Done' },
                  { id: 'opt-ready', name: 'Ready' },
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
                nodes: [{ id: 'ITEM-321', project: { id: 'PROJ' } }],
              },
            },
          },
        };
      }
      if (query.includes('updateProjectV2ItemFieldValue')) {
        if (throwOnMutation) {
          throw new Error('graphql boom');
        }
        return {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.itemId } },
        };
      }
      return {};
    },
  };
}

describe('transitionTicketState — Projects v2 Status column sync', () => {
  it('mirrors agent::executing onto the In Progress column via a single mutation', async () => {
    const provider = buildFakeProvider();

    await transitionTicketState(provider, 321, 'agent::executing');

    const mutationCalls = provider.graphqlCalls.filter((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.equal(
      mutationCalls.length,
      1,
      'exactly one Status field mutation per transition',
    );
    assert.equal(mutationCalls[0].vars.projectId, 'PROJ');
    assert.equal(mutationCalls[0].vars.itemId, 'ITEM-321');
    assert.equal(mutationCalls[0].vars.fieldId, 'FIELD');
    assert.equal(mutationCalls[0].vars.optionId, 'opt-inprog');
    assert.ok(
      provider._labels.includes('agent::executing'),
      'label flip recorded',
    );
  });

  it('mirrors agent::blocked onto the Blocked column', async () => {
    const provider = buildFakeProvider();

    await transitionTicketState(provider, 321, 'agent::blocked');

    const mutation = provider.graphqlCalls.find((c) =>
      c.query.includes('updateProjectV2ItemFieldValue'),
    );
    assert.ok(mutation, 'mutation issued');
    assert.equal(mutation.vars.optionId, 'opt-blocked');
  });

  it('does not propagate column-sync failures (best-effort mirror)', async () => {
    const provider = buildFakeProvider({ throwOnMutation: true });

    // The graphql mutation throws inside ColumnSync.sync. The
    // transitionTicketState contract is that this MUST be caught and
    // logged — the label flip outcome must not regress because the
    // board is misconfigured or the API is flapping.
    await assert.doesNotReject(
      () => transitionTicketState(provider, 321, 'agent::executing'),
      'column-sync errors must be swallowed',
    );

    // The label flip still landed via provider.updateTicket regardless
    // of the column-sync failure.
    assert.ok(
      provider._labels.includes('agent::executing'),
      'label flip survives graphql failure',
    );
  });
});
