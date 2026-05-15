/**
 * Story #1795 — Throw-away ghSpawnCount emitter contract tests.
 *
 * `emitGhSpawnCount` snapshots the in-process gh-exec counter to disk so
 * the perf-summary analyzer (child process) can surface it on the
 * `story-perf-summary` structured comment. The emitter is best-effort:
 * invalid IDs, counter-read failures, and write failures all resolve to
 * a `failed` envelope rather than throwing, so a measurement-only
 * artifact never blocks Story close.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emitGhSpawnCount } from '../../.agents/scripts/lib/close-validation.js';
import { defaultGetHeadSha } from '../../.agents/scripts/lib/close-validation/projections/head-sha.js';

describe('emitGhSpawnCount — happy path', () => {
  it('writes the counter to story-scoped temp path and returns ok', async () => {
    const captures = [];
    const writeFileFn = async (target, body) => {
      captures.push({ target, body });
    };
    const result = await emitGhSpawnCount({
      epicId: 1788,
      storyId: 1795,
      writeFileFn,
      getSpawnCountFn: () => 42,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.ghSpawnCount, 42);
    assert.equal(captures.length, 1);
    assert.match(
      captures[0].target.replace(/\\/g, '/'),
      /gh-spawn-count\.json$/,
    );
    const parsed = JSON.parse(captures[0].body);
    assert.equal(parsed.kind, 'gh-spawn-count');
    assert.equal(parsed.epicId, 1788);
    assert.equal(parsed.storyId, 1795);
    assert.equal(parsed.ghSpawnCount, 42);
    assert.equal(typeof parsed.capturedAt, 'string');
  });
});

describe('emitGhSpawnCount — failure paths', () => {
  it('returns failed:invalid-ids when storyId is not a positive integer', async () => {
    const result = await emitGhSpawnCount({
      epicId: 1788,
      storyId: 0,
      writeFileFn: async () => {},
      getSpawnCountFn: () => 1,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'invalid-ids');
  });

  it('returns failed:write-failed and never throws when writeFile rejects', async () => {
    const warnings = [];
    const writeFileFn = async () => {
      throw new Error('EACCES: read-only filesystem');
    };
    const result = await emitGhSpawnCount({
      epicId: 1788,
      storyId: 1795,
      writeFileFn,
      getSpawnCountFn: () => 7,
      logger: { warn: (s) => warnings.push(s) },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'write-failed');
    assert.ok(warnings.some((w) => /gh-spawn-count emit failed/.test(w)));
  });

  it('returns failed:counter-read-failed when getSpawnCount throws', async () => {
    const result = await emitGhSpawnCount({
      epicId: 1788,
      storyId: 1795,
      writeFileFn: async () => {},
      getSpawnCountFn: () => {
        throw new Error('counter unavailable');
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'counter-read-failed');
  });
});

describe('defaultGetHeadSha — re-export contract (Story #1850 / Task #1873)', () => {
  it('resolves a clean SHA from the injected gitSpawn', () => {
    const gitSpawn = () => ({ status: 0, stdout: 'deadbeef\n', stderr: '' });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), 'deadbeef');
  });

  it('returns null when gitSpawn reports a non-zero status', () => {
    const gitSpawn = () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repo',
    });
    assert.equal(defaultGetHeadSha('/repo', gitSpawn), null);
  });
});
