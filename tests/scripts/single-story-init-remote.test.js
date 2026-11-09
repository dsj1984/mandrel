import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { composeStoryInitResult } from '../../.agents/scripts/lib/orchestration/story-init-result.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  assertNotForeignExecuting,
  handleRemoteVerificationFailure,
  materializeBaseBranch,
  runSingleStoryInit,
  seedStoryBranch,
} from '../../.agents/scripts/single-story-init.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args],
    { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: CLEAN_ENV },
  ).trim();
}

describe('materializeBaseBranch — clones whose local base cannot seed', () => {
  let origin;
  let parent;

  const advanceOrigin = (message) =>
    git(origin, 'commit', '-q', '--allow-empty', '-m', message);
  const shallowClone = () => {
    const clone = path.join(parent, 'clone');
    git(
      parent,
      'clone',
      '-q',
      '--depth',
      '1',
      pathToFileURL(origin).href,
      clone,
    );
    return clone;
  };
  const materialize = async (cwd, baseBranch = 'main') => {
    const messages = [];
    await materializeBaseBranch({
      cwd,
      baseBranch,
      storyBranch: 'story-1',
      config: {},
      provider: {},
      injectedSweep: async () => ({}),
      worktreeSweepFn: async () => ({ reaped: [], skipped: [] }),
      progress: (_phase, msg) => messages.push(msg),
    });
    return messages;
  };
  const seed = (cwd) =>
    seedStoryBranch({
      cwd,
      storyBranch: 'story-1',
      baseBranch: 'main',
      progress: () => {},
    });

  beforeEach(() => {
    origin = makeGitRepo({ prefix: 'ssi-origin-' });
    parent = makeTempDir('ssi-clone-');
    advanceOrigin('second');
  });

  afterEach(() => {
    fs.rmSync(origin, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('deepens a shallow clone and seeds at the remote tip past a stale local base', async () => {
    const clone = shallowClone();
    advanceOrigin('third');
    fs.writeFileSync(path.join(clone, 'dirty.txt'), 'blocks the fast-forward');
    const staleLocal = git(clone, 'rev-parse', 'main');

    await materialize(clone);
    seed(clone);

    assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false');
    assert.equal(git(clone, 'rev-parse', 'main'), staleLocal);
    assert.equal(
      git(clone, 'rev-parse', 'story-1'),
      git(origin, 'rev-parse', 'main'),
    );
  });

  it('stops init naming the command when the unshallow fails', async () => {
    await assert.rejects(
      materialize(shallowClone(), 'no-such-base'),
      /`git fetch --unshallow origin no-such-base` failed/,
    );
  });

  it('warns once on a local base with no shared history and still seeds from the remote', async () => {
    const clone = path.join(parent, 'unrelated');
    git(parent, 'clone', '-q', pathToFileURL(origin).href, clone);
    git(clone, 'checkout', '-q', '--orphan', 'replacement');
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'unrelated root');
    git(clone, 'branch', '-M', 'replacement', 'main');

    const messages = await materialize(clone);
    seed(clone);

    assert.equal(messages.filter((m) => m.includes('⚠️')).length, 1);
    assert.match(
      messages.find((m) => m.includes('⚠️')),
      /local main shares no history with origin\/main/,
    );
    assert.equal(
      git(clone, 'rev-parse', 'story-1'),
      git(origin, 'rev-parse', 'main'),
    );
  });
});

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

  /**
   * Story #5784 — the executing flip is no longer best-effort: a Story left
   * at `agent::ready` with an assignee reads as a stalled dispatch to the
   * wave tick and as a foreign claim to the next init.
   */
  it('rolls the claim back and throws when the executing flip fails, before provisioning', async () => {
    const provider = recordingProvider();
    provider.getTicket = async () => ({
      labels: ['type::story', 'agent::ready'],
      title: 'Story 4620',
      body: '## Goal\nx',
      assignees: ['dsj1984'],
      state: 'open',
    });
    const recordWrite = provider.updateTicket;
    provider.updateTicket = async (id, mutations) => {
      if (mutations?.labels?.add?.[0] === 'agent::executing') {
        throw new Error('label write refused');
      }
      return recordWrite(id, mutations);
    };
    let provisioned = false;

    await assert.rejects(
      () =>
        runSingleStoryInit(
          baseArgs(provider, {
            injectedProvisionWorktree: async () => {
              provisioned = true;
              return {};
            },
          }),
        ),
      /label write refused/,
    );

    assert.equal(provisioned, false, 'no worktree for an unpublished claim');
    assert.deepEqual(provider.transitions, ['agent::ready']);
    assert.deepEqual(
      provider.assigneeWrites.at(-1),
      [],
      'the lease is released with the rollback',
    );
  });

  it('carries the executing flip board outcome in the result and summary', async () => {
    const provider = recordingProvider();
    provider.getTicket = async () => ({
      labels: ['type::story', 'agent::ready'],
      title: 'Story 4620',
      body: '## Goal\nx',
      assignees: ['dsj1984'],
      state: 'open',
    });

    const { result } = await runSingleStoryInit(
      baseArgs(provider, {
        injectedProvisionWorktree: async () => ({
          workCwd: '/tmp/wt',
          worktreeCreated: true,
          installStatus: { status: 'skipped', reason: 'test' },
        }),
      }),
    );

    // No `github.projectNumber` in CONFIG: the board is not configured.
    assert.deepEqual(result.boardSync, {
      status: 'skipped',
      reason: 'no-project',
    });
  });
});

describe('composeStoryInitResult — board-sync summary (Story #5784)', () => {
  function compose(boardSync) {
    return composeStoryInitResult({
      storyId: 5784,
      storyBranch: 'story-5784',
      baseBranch: 'main',
      config: { project: { baseBranch: 'main' } },
      story: { title: 't' },
      runtime: { worktreeEnabled: true },
      workCwd: '/tmp/wt',
      worktreeCreated: true,
      installStatus: { status: 'skipped' },
      worktreeSweep: null,
      dryRun: false,
      remote: { remoteVerified: true },
      checklistPath: null,
      boardSync,
    });
  }

  it('names a refused board sync and its reason on the stdout line', () => {
    const { result, summary } = compose({
      status: 'failed',
      reason: 'insufficient-scope',
      scope: 'project',
    });
    assert.equal(summary.boardSync, 'failed (insufficient-scope)');
    assert.equal(result.boardSync.reason, 'insufficient-scope');
  });

  it('reports a synced board as synced, and a dry-run as null', () => {
    assert.equal(
      compose({ status: 'synced', column: 'In Progress' }).summary.boardSync,
      'synced',
    );
    assert.equal(compose(null).summary.boardSync, null);
  });
});
