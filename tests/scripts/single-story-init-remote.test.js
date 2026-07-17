import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertNotForeignExecuting,
  handleRemoteVerificationFailure,
  runSingleStoryInit,
} from '../../.agents/scripts/single-story-init.js';

describe('single-story-init remote verification', () => {
  it('blocks the Story and throws before delivery mutation', async () => {
    const updates = [];
    const comments = [];
    const provider = {
      async getTicketComments() {
        return [];
      },
      async postComment(storyId, payload) {
        comments.push({ storyId, body: payload.body });
        return { id: 1 };
      },
      async deleteComment() {},
      async updateTicket(storyId, payload) {
        updates.push({ storyId, payload });
      },
    };

    await assert.rejects(
      () =>
        handleRemoteVerificationFailure({
          provider,
          storyId: 42,
          remote: {
            remoteVerified: false,
            detail: 'origin is unreachable',
          },
        }),
      /remote verification failed/,
    );
    // Story #4539 — this flip goes through the canonical
    // `transitionTicketState` mutator rather than a direct label write, so
    // the Projects v2 column follows the Story off `agent::ready`. Assert
    // the transition's meaning (blocked, every other state cleared) rather
    // than the mutator's exact payload shape, which is its own contract.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].storyId, 42);
    const { labels } = updates[0].payload;
    assert.deepEqual(labels.add, ['agent::blocked']);
    for (const cleared of [
      'agent::ready',
      'agent::executing',
      'agent::closing',
      'agent::done',
    ]) {
      assert.ok(
        labels.remove.includes(cleared),
        `the transition clears ${cleared}`,
      );
    }
    assert.match(comments[0].body, /origin is unreachable/);
  });

  it('does not mutate or throw for a verified remote', async () => {
    await handleRemoteVerificationFailure({
      provider: null,
      storyId: 42,
      remote: { remoteVerified: true },
    });
  });
});

describe('single-story-init — executing-label refusal (Story #4620)', () => {
  it('refuses an already-executing Story this run does not hold and releases the just-taken lease', async () => {
    const writes = [];
    const provider = {
      // The lease we just took reads as self-held on release.
      async getTicket() {
        return { assignees: ['dsj1984'] };
      },
      async updateTicket(_id, mutations) {
        writes.push(mutations);
      },
    };

    await assert.rejects(
      () =>
        assertNotForeignExecuting({
          story: { labels: ['type::story', 'agent::executing'] },
          lease: { reason: 'unclaimed', previousOwner: null },
          stealRequested: false,
          storyId: 42,
          provider,
          config: { github: { operatorHandle: '@dsj1984' } },
        }),
      /already labelled agent::executing.*--steal/s,
    );

    // The refusal backs the lease out so the ticket is left as found.
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].assignees, []);
  });

  it('proceeds (no throw) when the lease is self-held — an idempotent re-init', async () => {
    await assertNotForeignExecuting({
      story: { labels: ['agent::executing'] },
      lease: { reason: 'already-held', previousOwner: 'dsj1984' },
      stealRequested: false,
      storyId: 42,
      provider: null,
      config: {},
    });
  });

  it('proceeds when --steal was passed', async () => {
    await assertNotForeignExecuting({
      story: { labels: ['agent::executing'] },
      lease: { reason: 'stolen', previousOwner: 'bob' },
      stealRequested: true,
      storyId: 42,
      provider: null,
      config: {},
    });
  });

  it('is a no-op when the Story is not labelled executing', async () => {
    await assertNotForeignExecuting({
      story: { labels: ['type::story', 'agent::ready'] },
      lease: { reason: 'unclaimed', previousOwner: null },
      stealRequested: false,
      storyId: 42,
      provider: null,
      config: {},
    });
  });
});

describe('single-story-init — early claim publication + rollback (Story #4620)', () => {
  /**
   * A provider that records every label transition (the `labels.add[0]` of each
   * updateTicket call) and every assignee write, and always reads back the
   * operator as the sole assignee so `releaseStoryLease` writes.
   */
  function recordingProvider() {
    const transitions = [];
    const assigneeWrites = [];
    return {
      transitions,
      assigneeWrites,
      async getTicket() {
        return {
          labels: ['type::story', 'agent::ready'],
          assignees: ['dsj1984'],
          state: 'open',
        };
      },
      async updateTicket(_id, mutations) {
        if (mutations?.labels?.add) transitions.push(mutations.labels.add[0]);
        if (Array.isArray(mutations?.assignees)) {
          assigneeWrites.push(mutations.assignees);
        }
      },
    };
  }

  const CONFIG = {
    project: { baseBranch: 'main' },
    github: { operatorHandle: '@dsj1984' },
  };

  function baseArgs(provider, overrides = {}) {
    return {
      storyId: 4620,
      injectedProvider: provider,
      injectedConfig: CONFIG,
      injectedVerifyRemote: () => ({
        remoteVerified: true,
        remoteUrl: 'https://github.com/dsj1984/mandrel.git',
        detail: 'ok',
      }),
      injectedAcquireLease: async () => ({
        acquired: true,
        owner: 'dsj1984',
        previousOwner: null,
        reason: 'unclaimed',
      }),
      injectedMaterialize: async () => {},
      injectedSeedBranch: () => {},
      ...overrides,
    };
  }

  it('flips agent::executing BEFORE provisioning, then reverts to agent::ready when provisioning fails', async () => {
    const provider = recordingProvider();
    provider.getTicket = async () => ({
      // assertDeliverableStory + the transitions read this snapshot.
      labels: ['type::story', 'agent::ready'],
      title: 'Story 4620',
      body: '## Goal\nx',
      assignees: ['dsj1984'],
      state: 'open',
    });

    await assert.rejects(
      () =>
        runSingleStoryInit(
          baseArgs(provider, {
            injectedProvisionWorktree: async () => {
              throw new Error('worktree boom');
            },
          }),
        ),
      /worktree boom/,
    );

    // The claim was published before provisioning (executing first), then
    // rolled back to ready after the failure.
    assert.deepEqual(provider.transitions, [
      'agent::executing',
      'agent::ready',
    ]);
    // The lease was released on rollback (assignees cleared).
    assert.deepEqual(provider.assigneeWrites.at(-1), []);
  });

  it('on the happy path flips agent::executing before provisioning and does not roll back', async () => {
    const provider = recordingProvider();
    provider.getTicket = async () => ({
      labels: ['type::story', 'agent::ready'],
      title: 'Story 4620',
      body: '## Goal\nx',
      assignees: ['dsj1984'],
      state: 'open',
    });

    const provisionOrder = [];
    const { success } = await runSingleStoryInit(
      baseArgs(provider, {
        injectedProvisionWorktree: async () => {
          // At provisioning time the executing flip has already happened.
          provisionOrder.push([...provider.transitions]);
          return {
            workCwd: '/tmp/wt',
            worktreeCreated: true,
            installStatus: { status: 'skipped', reason: 'test' },
          };
        },
      }),
    );

    assert.equal(success, true);
    // executing was flipped before provisioning ran, and no ready-rollback.
    assert.deepEqual(provisionOrder[0], ['agent::executing']);
    assert.deepEqual(provider.transitions, ['agent::executing']);
  });
});
