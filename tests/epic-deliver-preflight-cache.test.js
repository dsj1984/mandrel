// tests/epic-deliver-preflight-cache.test.js
/**
 * Unit tests — Story #3027 Task #3036 (Epic #3019).
 *
 * `epic-deliver-preflight.js` MUST persist its snapshot/DAG result to
 * `temp/epic-<id>/preflight-snapshot.json` so `epic-deliver-prepare.js`
 * can reuse the envelope instead of re-walking Epic → Feature → Story.
 *
 * Acceptance:
 *   - Running the preflight writes the cache file with `epic`, `stories`,
 *     and `waves` populated from `runSnapshotPhase` + `runBuildWaveDagPhase`.
 *   - The envelope carries a `baseSha` derived from the same `getTicket`
 *     call used to walk the hierarchy. Re-computing the digest off the
 *     persisted `epic` snapshot reproduces the stored value byte-for-byte.
 *   - `--dry-run` is side-effect-light: no file is written.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runPreflight } from '../.agents/scripts/epic-deliver-preflight.js';
import {
  computeBaseSha,
  preflightCachePath,
} from '../.agents/scripts/lib/orchestration/preflight-cache.js';

function buildFakeProvider({ epicId, stories, epicOverrides = {} }) {
  return {
    async getTicket(id) {
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
      return stories;
    },
  };
}

const FAKE_CONFIG = {
  delivery: {
    preflight: {
      maxStories: null,
      maxWaves: null,
      maxInstallCostSeconds: null,
      maxGithubApiRequests: null,
      maxClaudeQuotaTokens: null,
    },
  },
  orchestration: { provider: 'github' },
};

describe('epic-deliver-preflight cache write', () => {
  let workCwd;

  beforeEach(async () => {
    workCwd = await mkdtemp(path.join(tmpdir(), 'preflight-cache-'));
  });

  afterEach(async () => {
    await rm(workCwd, { recursive: true, force: true });
  });

  it('persists snapshot+DAG envelope to temp/epic-<id>/preflight-snapshot.json', async () => {
    const stories = [101, 102].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    const provider = buildFakeProvider({ epicId: 4242, stories });

    const envelope = await runPreflight({
      epicId: 4242,
      cwd: workCwd,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    assert.equal(envelope.cacheWritten, true);
    assert.equal(typeof envelope.baseSha, 'string');
    assert.ok(envelope.baseSha.length > 0);

    const cachePath = preflightCachePath({ epicId: 4242, cwd: workCwd });
    const raw = await readFile(cachePath, 'utf8');
    const cached = JSON.parse(raw);

    assert.equal(cached.epicId, 4242);
    assert.equal(cached.baseSha, envelope.baseSha);
    assert.equal(typeof cached.capturedAt, 'string');
    assert.equal(cached.epic.id, 4242);
    assert.ok(Array.isArray(cached.stories));
    assert.equal(cached.stories.length, 2);
    assert.ok(Array.isArray(cached.waves));
    assert.equal(cached.waves.length, 1);
  });

  it('baseSha is derived from the same getTicket snapshot used to walk the hierarchy', async () => {
    const stories = [201].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    const provider = buildFakeProvider({ epicId: 7777, stories });

    const envelope = await runPreflight({
      epicId: 7777,
      cwd: workCwd,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    const cachePath = preflightCachePath({ epicId: 7777, cwd: workCwd });
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));

    // Re-deriving the digest off the persisted epic snapshot reproduces
    // the stored baseSha byte-for-byte. This is the cache key prepare
    // will compare against.
    const recomputed = computeBaseSha(cached.epic);
    assert.equal(recomputed, envelope.baseSha);
    assert.equal(recomputed, cached.baseSha);
  });

  it('--dry-run does NOT write the cache file', async () => {
    const stories = [301].map((id) => ({
      id,
      number: id,
      labels: ['type::story'],
      body: '',
      title: `Story #${id}`,
      state: 'open',
    }));
    const provider = buildFakeProvider({ epicId: 5151, stories });

    const envelope = await runPreflight({
      epicId: 5151,
      cwd: workCwd,
      dryRun: true,
      injectedProvider: provider,
      injectedConfig: FAKE_CONFIG,
    });

    assert.equal(envelope.cacheWritten, false);
    const cachePath = preflightCachePath({ epicId: 5151, cwd: workCwd });
    await assert.rejects(
      () => readFile(cachePath, 'utf8'),
      (err) => err.code === 'ENOENT',
    );
  });

  it('differing label or body produces a distinct baseSha', () => {
    const a = computeBaseSha({
      id: 1,
      body: '',
      labels: ['a'],
      updatedAt: '2026-05-26T00:00:00Z',
    });
    const b = computeBaseSha({
      id: 1,
      body: '',
      labels: ['b'],
      updatedAt: '2026-05-26T00:00:00Z',
    });
    const c = computeBaseSha({
      id: 1,
      body: 'changed',
      labels: ['a'],
      updatedAt: '2026-05-26T00:00:00Z',
    });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it('label order does not affect baseSha (sorted before hashing)', () => {
    const a = computeBaseSha({
      id: 1,
      body: '',
      labels: ['x', 'y', 'z'],
      updatedAt: '2026-05-26T00:00:00Z',
    });
    const b = computeBaseSha({
      id: 1,
      body: '',
      labels: ['z', 'y', 'x'],
      updatedAt: '2026-05-26T00:00:00Z',
    });
    assert.equal(a, b);
  });
});
