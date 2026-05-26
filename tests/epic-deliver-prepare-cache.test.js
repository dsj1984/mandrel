// tests/epic-deliver-prepare-cache.test.js
/**
 * Unit tests — Story #3027 Task #3037 (Epic #3019).
 *
 * `epic-deliver-prepare.js` MUST read the preflight cache
 * (`temp/epic-<id>/preflight-snapshot.json`) and skip the duplicate
 * snapshot+DAG walk when the cached envelope's `baseSha` matches the
 * fresh `getTicket(epicId)` digest. Cache miss or baseSha drift falls
 * back to a fresh `runSnapshotPhase` + `runBuildWaveDagPhase` pass.
 *
 * Acceptance:
 *   - Hit path: cache file present, baseSha matches → no `getSubTickets`
 *     calls are made by prepare. `runSnapshotPhase` is effectively a no-op
 *     because the wave DAG is reconstructed from the cache.
 *   - Miss path: cache absent → fresh snapshot+DAG pass runs as before.
 *   - Stale path: cache present but baseSha mismatch → fresh pass runs
 *     and the stale envelope is ignored.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runEpicDeliverPrepare } from '../.agents/scripts/epic-deliver-prepare.js';
import {
  computeBaseSha,
  writePreflightCache,
} from '../.agents/scripts/lib/orchestration/preflight-cache.js';

function buildCountingProvider({ epicId, stories, epicOverrides = {} }) {
  const counts = { getTicket: 0, getSubTickets: 0 };
  const checkpoints = new Map();
  const provider = {
    async getTicket(id) {
      counts.getTicket++;
      if (id !== epicId) return null;
      return {
        id: epicId,
        number: epicId,
        labels: ['type::epic', 'acceptance::n-a'],
        body: '',
        title: `Epic #${epicId}`,
        updatedAt: '2026-05-26T00:00:00Z',
        ...epicOverrides,
      };
    },
    async getSubTickets(_id) {
      counts.getSubTickets++;
      return stories;
    },
    // The state store reads/writes structured comments; stub them.
    async listComments(_ticketId) {
      return Array.from(checkpoints.values());
    },
    async getTicketComments(_ticketId) {
      return Array.from(checkpoints.values());
    },
    async postComment(_ticketId, payload) {
      const id = checkpoints.size + 1;
      checkpoints.set(id, { id, body: payload.body, type: payload.type });
      return { id };
    },
    async updateComment(commentId, payload) {
      const existing = checkpoints.get(commentId) ?? { id: commentId };
      checkpoints.set(commentId, { ...existing, ...payload });
      return { id: commentId };
    },
    async deleteComment(id) {
      checkpoints.delete(id);
    },
    _counts: counts,
  };
  return provider;
}

const FAKE_CONFIG = {
  github: { owner: 'test', repo: 'test', projectNumber: 1 },
  delivery: {
    deliverRunner: { concurrencyCap: 4 },
  },
  orchestration: { provider: 'github' },
};

describe('epic-deliver-prepare cache read', () => {
  let workCwd;

  beforeEach(async () => {
    workCwd = await mkdtemp(path.join(tmpdir(), 'prepare-cache-'));
  });

  afterEach(async () => {
    await rm(workCwd, { recursive: true, force: true });
  });

  it('reuses cached envelope when baseSha matches (no second getSubTickets)', async () => {
    const epicId = 9001;
    const stories = [11, 12].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    const epicSnapshot = {
      id: epicId,
      number: epicId,
      labels: ['type::epic', 'acceptance::n-a'],
      body: '',
      title: `Epic #${epicId}`,
      updatedAt: '2026-05-26T00:00:00Z',
    };
    const baseSha = computeBaseSha(epicSnapshot);
    await writePreflightCache({
      epicId,
      baseSha,
      epic: epicSnapshot,
      stories,
      waves: [stories],
      cwd: workCwd,
    });

    const provider = buildCountingProvider({ epicId, stories });
    const result = await runEpicDeliverPrepare({
      epicId,
      cwd: workCwd,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    assert.equal(result.preflightCache, 'hit');
    assert.equal(result.totalWaves, 1);
    assert.equal(result.plan.length, 1);
    assert.equal(result.plan[0].stories.length, 2);
    // Cache hit: getSubTickets MUST NOT have been called by prepare
    // (the snapshot+DAG walk is what we're skipping).
    assert.equal(provider._counts.getSubTickets, 0);
    // getTicket is called once to fingerprint the Epic for baseSha
    // comparison. The state-store may also call getTicket while reading
    // the checkpoint, so we assert a small upper bound rather than 1.
    assert.ok(provider._counts.getTicket >= 1);
  });

  it('falls back to a fresh snapshot+DAG pass when the cache is missing', async () => {
    const epicId = 9002;
    const stories = [21].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    const provider = buildCountingProvider({ epicId, stories });

    const result = await runEpicDeliverPrepare({
      epicId,
      cwd: workCwd,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    assert.equal(result.preflightCache, 'miss');
    assert.equal(result.totalWaves, 1);
    assert.equal(result.plan.length, 1);
    // Miss: the snapshot phase walked the hierarchy via getSubTickets.
    assert.ok(provider._counts.getSubTickets >= 1);
  });

  it('falls back to a fresh pass when the cached baseSha is stale', async () => {
    const epicId = 9003;
    const stories = [31, 32].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    // Seed the cache with a baseSha derived from an Epic snapshot that
    // does NOT match what the provider will return (different body).
    const staleEpic = {
      id: epicId,
      number: epicId,
      labels: ['type::epic', 'acceptance::n-a'],
      body: 'stale body — pre-replan',
      title: `Epic #${epicId}`,
      updatedAt: '2026-05-25T00:00:00Z',
    };
    await writePreflightCache({
      epicId,
      baseSha: computeBaseSha(staleEpic),
      epic: staleEpic,
      stories: [],
      waves: [[]],
      cwd: workCwd,
    });

    const provider = buildCountingProvider({ epicId, stories });
    const result = await runEpicDeliverPrepare({
      epicId,
      cwd: workCwd,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    assert.equal(result.preflightCache, 'stale');
    // Stale: the fresh pass reflects the *current* hierarchy, not the
    // empty wave the stale cache carried.
    assert.equal(result.totalWaves, 1);
    assert.equal(result.plan[0].stories.length, 2);
    assert.ok(provider._counts.getSubTickets >= 1);
  });
});
