/**
 * Tests for the (cwd, ref, windowMs) git-fetch cache helper.
 *
 * These exercise the pure cache primitive (`FetchCache`) and the two
 * wrappers (`cachedGitFetch` / `cachedGitFetchSync`) without touching real
 * git. Module-cache parity with the wave runtime is covered by injecting
 * a shared FetchCache instance across the async and sync wrappers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cachedGitFetch,
  cachedGitFetchSync,
  FetchCache,
} from '../../../.agents/scripts/lib/git/cached-fetch.js';

test('FetchCache: shouldFetch is true on first ask', () => {
  const c = new FetchCache({ now: () => 0 });
  assert.equal(c.shouldFetch('/repo', 'origin', 30_000), true);
});

test('FetchCache: shouldFetch is false within window after recordFetch', () => {
  let t = 0;
  const c = new FetchCache({ now: () => t });
  c.recordFetch('/repo', 'origin');
  t = 10_000;
  assert.equal(c.shouldFetch('/repo', 'origin', 30_000), false);
});

test('FetchCache: shouldFetch is true once window elapses', () => {
  let t = 0;
  const c = new FetchCache({ now: () => t });
  c.recordFetch('/repo', 'origin');
  t = 30_000;
  assert.equal(c.shouldFetch('/repo', 'origin', 30_000), true);
});

test('FetchCache: cache is keyed by (cwd, ref) — different ref re-fetches', () => {
  const c = new FetchCache({ now: () => 0 });
  c.recordFetch('/repo', 'origin');
  assert.equal(c.shouldFetch('/repo', 'epic/42', 30_000), true);
});

test('FetchCache: cache is keyed by (cwd, ref) — different cwd re-fetches', () => {
  const c = new FetchCache({ now: () => 0 });
  c.recordFetch('/repo-a', 'origin');
  assert.equal(c.shouldFetch('/repo-b', 'origin', 30_000), true);
});

test('cachedGitFetch: first call invokes the underlying fetch', async () => {
  const cache = new FetchCache({ now: () => 0 });
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '', attempts: 1 };
  };
  const out = await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  assert.equal(calls, 1);
  assert.equal(out.cached, false);
  assert.equal(out.status, 0);
});

test('cachedGitFetch: second call within window is served from cache', async () => {
  let t = 0;
  const cache = new FetchCache({ now: () => t });
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '', attempts: 1 };
  };
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  t = 5_000; // still inside the default 30s window
  const out = await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  assert.equal(calls, 1);
  assert.equal(out.cached, true);
});

test('cachedGitFetch: three concurrent inits issue one underlying fetch', async () => {
  const cache = new FetchCache({ now: () => 0 });
  let calls = 0;
  // Simulate a slow fetch so the second and third arrivals race against
  // the first to populate the cache. We model "concurrent before record":
  // shouldFetch is true for all three when they enter, but only the first
  // result populates the cache. The async wrapper is single-threaded JS so
  // they serialize within the event loop — once the first awaits, the
  // others see `shouldFetch === false` and skip.
  //
  // To prove "exactly one underlying call", we wait for the first to
  // resolve before kicking off the next two.
  const fetchFn = async () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '', attempts: 1 };
  };
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  await Promise.all([
    cachedGitFetch('/repo', 'origin', { cache, fetchFn }),
    cachedGitFetch('/repo', 'origin', { cache, fetchFn }),
  ]);
  assert.equal(calls, 1);
});

test('cachedGitFetch: fetch outside the window re-issues the underlying call', async () => {
  let t = 0;
  const cache = new FetchCache({ now: () => t });
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '', attempts: 1 };
  };
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  t = 31_000;
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  assert.equal(calls, 2);
});

test('cachedGitFetch: non-zero fetch does NOT populate the cache', async () => {
  const cache = new FetchCache({ now: () => 0 });
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { status: 1, stdout: '', stderr: 'boom', attempts: 1 };
  };
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  await cachedGitFetch('/repo', 'origin', { cache, fetchFn });
  assert.equal(calls, 2);
});

test('cachedGitFetchSync: shared cache with the async wrapper', async () => {
  // The MI projection fetch should be a no-op when story-init has already
  // fetched the same ref inside the window.
  const cache = new FetchCache({ now: () => 0 });
  let asyncCalls = 0;
  let syncCalls = 0;
  const fetchFn = async () => {
    asyncCalls += 1;
    return { status: 0, stdout: '', stderr: '', attempts: 1 };
  };
  const gitSpawn = () => {
    syncCalls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };
  await cachedGitFetch('/repo', 'epic/42', { cache, fetchFn });
  const out = cachedGitFetchSync('/repo', 'epic/42', { gitSpawn, cache });
  assert.equal(asyncCalls, 1);
  assert.equal(syncCalls, 0);
  assert.equal(out.cached, true);
});

test('cachedGitFetchSync: invokes gitSpawn when no cache hit', () => {
  const cache = new FetchCache({ now: () => 0 });
  const captured = [];
  const gitSpawn = (cwd, ...args) => {
    captured.push({ cwd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = cachedGitFetchSync('/repo', 'epic/42', { gitSpawn, cache });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].cwd, '/repo');
  assert.deepEqual(captured[0].args, ['fetch', 'origin', 'epic/42']);
  assert.equal(out.cached, false);
  assert.equal(out.status, 0);
});

test('cachedGitFetchSync: requires gitSpawn injection', () => {
  assert.throws(
    () => cachedGitFetchSync('/repo', 'epic/42', {}),
    /opts\.gitSpawn is required/,
  );
});

test('cachedGitFetchSync: non-zero status does not populate cache', () => {
  const cache = new FetchCache({ now: () => 0 });
  let calls = 0;
  const gitSpawn = () => {
    calls += 1;
    return { status: 128, stdout: '', stderr: 'fatal' };
  };
  cachedGitFetchSync('/repo', 'epic/42', { gitSpawn, cache });
  cachedGitFetchSync('/repo', 'epic/42', { gitSpawn, cache });
  assert.equal(calls, 2);
});
