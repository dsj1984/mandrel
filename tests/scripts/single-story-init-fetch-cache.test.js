/**
 * tests/scripts/single-story-init-fetch-cache.test.js — Story #3654
 *
 * Verifies that `materializeBaseBranch` routes its `git fetch origin` call
 * through `cachedGitFetch` so concurrent standalone Story waves share the
 * same per-process coalescing window that Epic-attached stories get via
 * `branch-initializer.js#fetchMainRefs`.
 *
 * Every call runs against a throwaway clone of a fixture origin, never the
 * checkout under test: `materializeBaseBranch` fast-forwards the local base,
 * which checked out `main` in the real worktree mid-suite (#6101).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  __DEFAULT_WINDOW_MS,
  __moduleCacheSize,
  __resetModuleCache,
  FetchCache,
} from '../../.agents/scripts/lib/git/cached-fetch.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { materializeBaseBranch } from '../../.agents/scripts/single-story-init.js';
import { makeGitRepo } from '../fixtures/git-fixture.js';

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

/** Stub sweep — always no-op so only the fetch path is exercised. */
const noopSweep = async () => ({});

/** Keeps the closed-Story worktree sweep off the real checkout (Story #5461). */
const noopWorktreeSweep = async () => ({ reaped: [], skipped: [] });

/** Stub config — minimal shape the function needs. */
const stubConfig = {};

/** Stub provider — unused here since sweep is injected. */
const stubProvider = {};

/**
 * Build a progress recorder that captures `[level, msg]` pairs. Lets tests
 * assert which progress messages were emitted without asserting on the exact
 * wording of unrelated lines.
 */
function makeProgress() {
  const calls = [];
  const fn = (level, msg) => {
    calls.push([level, msg]);
  };
  fn.calls = calls;
  return fn;
}

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

/**
 * A throwaway clone of a fixture origin. `materializeBaseBranch` runs real git
 * after the fetch (sweep, fast-forward), so it must never point at the
 * checkout under test.
 */
function makeClone() {
  const origin = makeGitRepo({ prefix: 'fetch-cache-origin-' });
  const clone = path.join(makeTempDir('fetch-cache-clone-'), 'clone');
  execFileSync('git', ['clone', '-q', pathToFileURL(origin).href, clone], {
    env: CLEAN_ENV,
    stdio: 'pipe',
  });
  return { origin, clone };
}

const materialize = (cwd, cache, progress) =>
  materializeBaseBranch({
    cwd,
    baseBranch: 'main',
    storyBranch: 'story-3654',
    config: stubConfig,
    provider: stubProvider,
    injectedSweep: noopSweep,
    worktreeSweepFn: noopWorktreeSweep,
    progress,
    fetchCache: cache,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('materializeBaseBranch — cachedGitFetch coalescing (Story #3654)', () => {
  let dirs;

  beforeEach(() => {
    dirs = makeClone();
    __resetModuleCache();
  });

  afterEach(() => {
    for (const dir of Object.values(dirs)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves the fetch from a warm cache instead of the network', async () => {
    const cache = new FetchCache({ now: () => 0 });
    cache.recordFetch(dirs.clone, 'origin');
    const progress = makeProgress();

    await materialize(dirs.clone, cache, progress);

    const cacheMessages = progress.calls.filter(([, msg]) =>
      msg.includes('cache'),
    );
    assert.ok(
      cacheMessages.length > 0,
      `Expected a cache-hit progress message but got: ${JSON.stringify(progress.calls)}`,
    );
    assert.match(cacheMessages[0][1], /served from.*cache/i);
  });

  it('issues a real fetch when the cache is cold (first call per cwd)', async () => {
    const cache = new FetchCache({ now: () => 0 });
    const progress = makeProgress();

    await materialize(dirs.clone, cache, progress);

    const cacheHitMessages = progress.calls.filter(
      ([, msg]) => msg.includes('served from') && msg.includes('cache'),
    );
    assert.equal(
      cacheHitMessages.length,
      0,
      `Did not expect a cache-hit message on a cold cache but got: ${JSON.stringify(progress.calls)}`,
    );
    assert.equal(
      cache.shouldFetch(dirs.clone, 'origin', __DEFAULT_WINDOW_MS),
      false,
    );
    assert.equal(
      __moduleCacheSize(),
      0,
      'an injected cache leaves the module cache alone',
    );
  });

  it('records a fetch in the cache so the next call is a hit', () => {
    const cache = new FetchCache({ now: () => 0 });
    cache.recordFetch(dirs.clone, 'origin');
    assert.equal(
      cache.shouldFetch(dirs.clone, 'origin', __DEFAULT_WINDOW_MS),
      false,
    );
  });
});
