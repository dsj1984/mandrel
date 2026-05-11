import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import check from '../../../.agents/scripts/lib/checks/epic-merge-lock-stale.js';

/**
 * Unit tests for the epic-merge-lock-stale check. detect() reads
 * state.fs.epicMergeLocks; tests build fixture state directly without
 * touching the filesystem.
 */

function makeState(locks) {
  return {
    scope: 'story-close',
    git: {},
    fs: { epicMergeLocks: locks },
    env: {},
  };
}

describe('epic-merge-lock-stale check', () => {
  it('returns a warning Finding when a lock exists but the holder PID is dead', async () => {
    const state = makeState({
      1143: {
        exists: true,
        path: '/repo/.git/epic-1143.merge.lock',
        pid: 99999,
        acquiredAt: Date.now() - 60_000,
        holderAlive: false,
        mtimeMs: Date.now() - 60_000,
      },
    });
    const finding = await check.detect(state);
    assert.ok(finding, 'expected a Finding');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.id, 'epic-merge-lock-stale');
    assert.match(finding.summary, /1143/);
    assert.match(finding.summary, /99999/);
  });

  it('returns null when no lock file exists for any epic', async () => {
    const state = makeState({
      1143: {
        exists: false,
        path: '/repo/.git/epic-1143.merge.lock',
        pid: null,
        holderAlive: false,
        acquiredAt: null,
        mtimeMs: null,
      },
    });
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('returns null when the lock exists and the holder PID is alive', async () => {
    const state = makeState({
      1143: {
        exists: true,
        path: '/repo/.git/epic-1143.merge.lock',
        pid: process.pid,
        acquiredAt: Date.now(),
        holderAlive: true,
        mtimeMs: Date.now(),
      },
    });
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('returns null when the epicMergeLocks map is empty', async () => {
    const state = makeState({});
    const finding = await check.detect(state);
    assert.equal(finding, null);
  });

  it('fixCommand cites the literal rm of the lock path', async () => {
    const state = makeState({
      1143: {
        exists: true,
        path: '/repo/.git/epic-1143.merge.lock',
        pid: 99999,
        acquiredAt: Date.now() - 60_000,
        holderAlive: false,
        mtimeMs: Date.now() - 60_000,
      },
    });
    const finding = await check.detect(state);
    assert.ok(finding);
    assert.match(finding.fixCommand, /^rm /);
    assert.match(finding.fixCommand, /epic-1143\.merge\.lock/);
  });

  it('declares the contract metadata correctly', () => {
    assert.equal(check.id, 'epic-merge-lock-stale');
    assert.equal(check.severity, 'warning');
    assert.equal(check.autoCorrect, 'refuse-and-print');
    assert.ok(check.scope.includes('story-close'));
  });
});
