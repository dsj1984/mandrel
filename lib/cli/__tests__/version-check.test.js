// lib/cli/__tests__/version-check.test.js
/**
 * Unit tests for lib/cli/version-check.js — the daily-cached version freshness
 * check (Story #3500, Epic #3437).
 *
 * Every test drives the module through injectable seams (cachePath, now,
 * runner, fs, log) backed by an in-memory filesystem fake, so no real disk I/O
 * and no real network access occur (testing-standards § Unit: all filesystem
 * and network I/O MUST be mocked).
 *
 * Coverage contract (per Story #3500 AC):
 *   1. Module shape — exports isStale, readCache, refreshCache.
 *   2. isStale with a FRESH cache (< 24h) returns the cached version and
 *      NEVER invokes the network runner seam.
 *   3. isStale with a STALE cache (> 24h) invokes the runner exactly once and
 *      refreshes the cache.
 *   4. isStale with a MISSING cache invokes the runner and writes a new cache.
 *   5. refreshCache persists { latestVersion, checkedAt } JSON under the path
 *      it is given, creating the temp-root directory.
 *   6. readCache returns null for missing / malformed / incomplete caches.
 *   7. Logging contract — the log seam receives only version strings and
 *      paths, never tokens or raw file contents.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_CACHE_FILENAME,
  isStale,
  readCache,
  refreshCache,
  STALE_AFTER_MS,
} from '../version-check.js';

// ---------------------------------------------------------------------------
// In-memory filesystem fake
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fs whose `seed` maps absolute file paths → string
 * contents. Tracks mkdir/write calls so tests can assert on persistence.
 */
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const mkdirCalls = [];
  const writeCalls = [];

  return {
    files,
    mkdirCalls,
    writeCalls,
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
    writeFileSync(p, contents, _enc) {
      writeCalls.push({ path: p, contents });
      files.set(p, contents);
    },
    mkdirSync(dir, opts) {
      mkdirCalls.push({ dir, opts });
    },
  };
}

const CACHE_PATH = path.join('/tmp', 'mandrel', DEFAULT_CACHE_FILENAME);

/** Capturing log seam. */
function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

// ---------------------------------------------------------------------------
// 1. Module shape
// ---------------------------------------------------------------------------

describe('version-check module shape', () => {
  it('exports isStale, readCache, and refreshCache functions', () => {
    assert.equal(typeof isStale, 'function');
    assert.equal(typeof readCache, 'function');
    assert.equal(typeof refreshCache, 'function');
  });

  it('exposes a 24h staleness window constant', () => {
    assert.equal(STALE_AFTER_MS, 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 2. isStale — fresh cache → NO network
// ---------------------------------------------------------------------------

describe('isStale with a fresh cache', () => {
  it('returns the cached version and never invokes the runner seam', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    // Checked 1 hour ago — well within the 24h window.
    const checkedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.2.3', checkedAt }),
    });

    let runnerCalls = 0;
    const runner = () => {
      runnerCalls++;
      return '9.9.9';
    };

    const result = await isStale({ cachePath: CACHE_PATH, now, runner, fs });

    assert.equal(runnerCalls, 0, 'fresh cache must not hit the network');
    assert.equal(result.stale, false);
    assert.equal(result.refreshed, false);
    assert.equal(result.latestVersion, '1.2.3');
    assert.equal(result.checkedAt, checkedAt);
    // No new write happened — cache untouched.
    assert.equal(fs.writeCalls.length, 0);
  });

  it('treats a cache just under 24h old as fresh (boundary)', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const checkedAt = new Date(
      now.getTime() - (STALE_AFTER_MS - 1000),
    ).toISOString();
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '2.0.0', checkedAt }),
    });

    let runnerCalls = 0;
    const result = await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: () => {
        runnerCalls++;
        return '3.0.0';
      },
      fs,
    });

    assert.equal(runnerCalls, 0);
    assert.equal(result.stale, false);
    assert.equal(result.latestVersion, '2.0.0');
  });
});

// ---------------------------------------------------------------------------
// 3. isStale — stale cache → ONE network call + refresh
// ---------------------------------------------------------------------------

describe('isStale with a stale cache', () => {
  it('invokes the runner exactly once and refreshes the cache', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    // Checked 25 hours ago — past the 24h window.
    const checkedAt = new Date(
      now.getTime() - 25 * 60 * 60 * 1000,
    ).toISOString();
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.0.0', checkedAt }),
    });

    let runnerCalls = 0;
    const runner = () => {
      runnerCalls++;
      return '1.5.0';
    };

    const result = await isStale({ cachePath: CACHE_PATH, now, runner, fs });

    assert.equal(
      runnerCalls,
      1,
      'stale cache must probe the network exactly once',
    );
    assert.equal(result.stale, true);
    assert.equal(result.refreshed, true);
    assert.equal(result.latestVersion, '1.5.0');
    assert.equal(result.checkedAt, now.toISOString());

    // The cache on disk now carries the refreshed record.
    const persisted = JSON.parse(fs.files.get(CACHE_PATH));
    assert.equal(persisted.latestVersion, '1.5.0');
    assert.equal(persisted.checkedAt, now.toISOString());
  });

  it('treats an exactly-24h-old cache as stale (boundary)', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const checkedAt = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.0.0', checkedAt }),
    });

    let runnerCalls = 0;
    const result = await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: () => {
        runnerCalls++;
        return '1.0.1';
      },
      fs,
    });

    assert.equal(runnerCalls, 1);
    assert.equal(result.stale, true);
    assert.equal(result.latestVersion, '1.0.1');
  });

  it('awaits an async runner that returns a promise', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const checkedAt = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    ).toISOString();
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.0.0', checkedAt }),
    });

    const result = await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: async () => Promise.resolve('4.4.4'),
      fs,
    });

    assert.equal(result.latestVersion, '4.4.4');
    assert.equal(result.refreshed, true);
  });
});

// ---------------------------------------------------------------------------
// 4. isStale — missing cache → runner + write
// ---------------------------------------------------------------------------

describe('isStale with a missing cache', () => {
  it('probes the network and writes a fresh cache', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const fs = makeFs({}); // no cache file seeded

    let runnerCalls = 0;
    const result = await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: () => {
        runnerCalls++;
        return '7.7.7';
      },
      fs,
    });

    assert.equal(runnerCalls, 1);
    assert.equal(result.stale, true);
    assert.equal(result.refreshed, true);
    assert.equal(result.latestVersion, '7.7.7');
    // Created the temp-root dir and wrote the cache.
    assert.equal(fs.mkdirCalls.length, 1);
    assert.equal(fs.writeCalls.length, 1);
    assert.ok(fs.files.has(CACHE_PATH));
  });

  it('throws when the cache is stale and no runner seam is provided', async () => {
    const fs = makeFs({}); // missing cache forces a refresh path
    await assert.rejects(
      () => isStale({ cachePath: CACHE_PATH, now: new Date(), fs }),
      /runner seam is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. refreshCache — persistence contract
// ---------------------------------------------------------------------------

describe('refreshCache', () => {
  it('persists { latestVersion, checkedAt } JSON under the given path', () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const fs = makeFs({});

    const record = refreshCache({
      cachePath: CACHE_PATH,
      latestVersion: '5.6.7',
      now,
      fs,
    });

    assert.deepEqual(record, {
      latestVersion: '5.6.7',
      checkedAt: now.toISOString(),
    });

    // Directory (temp root) created recursively, then file written.
    assert.equal(fs.mkdirCalls.length, 1);
    assert.equal(fs.mkdirCalls[0].dir, path.dirname(CACHE_PATH));
    assert.deepEqual(fs.mkdirCalls[0].opts, { recursive: true });

    const persisted = JSON.parse(fs.files.get(CACHE_PATH));
    assert.deepEqual(persisted, {
      latestVersion: '5.6.7',
      checkedAt: now.toISOString(),
    });
  });
});

// ---------------------------------------------------------------------------
// 6. readCache — null on missing / malformed / incomplete
// ---------------------------------------------------------------------------

describe('readCache', () => {
  it('returns the parsed record for a well-formed cache', () => {
    const checkedAt = '2026-06-03T00:00:00.000Z';
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.1.1', checkedAt }),
    });
    assert.deepEqual(readCache({ cachePath: CACHE_PATH, fs }), {
      latestVersion: '1.1.1',
      checkedAt,
    });
  });

  it('returns null when the file is missing', () => {
    const fs = makeFs({});
    assert.equal(readCache({ cachePath: CACHE_PATH, fs }), null);
  });

  it('returns null when the file is malformed JSON', () => {
    const fs = makeFs({ [CACHE_PATH]: 'not json {' });
    assert.equal(readCache({ cachePath: CACHE_PATH, fs }), null);
  });

  it('returns null when required fields are missing', () => {
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.0.0' }),
    });
    assert.equal(readCache({ cachePath: CACHE_PATH, fs }), null);
  });

  it('returns null when cachePath is falsy', () => {
    const fs = makeFs({});
    assert.equal(readCache({ cachePath: '', fs }), null);
  });
});

// ---------------------------------------------------------------------------
// 7. Logging contract — versions and paths only, never secrets/contents
// ---------------------------------------------------------------------------

describe('logging contract (security-baseline § 5)', () => {
  it('logs only version strings and paths on a fresh cache', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const checkedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const secretToken = 'npm_supersecrettoken1234567890';
    const fs = makeFs({
      [CACHE_PATH]: JSON.stringify({ latestVersion: '1.2.3', checkedAt }),
    });
    const log = makeLog();

    await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: () => secretToken, // never invoked on a fresh cache
      fs,
      log,
    });

    const joined = log.lines.join('\n');
    assert.ok(joined.includes('1.2.3'), 'should log the version string');
    assert.ok(!joined.includes(secretToken), 'must never log a token');
  });

  it('logs the version and path but not raw file contents on refresh', async () => {
    const now = new Date('2026-06-03T12:00:00.000Z');
    const fs = makeFs({});
    const log = makeLog();

    await isStale({
      cachePath: CACHE_PATH,
      now,
      runner: () => '8.8.8',
      fs,
      log,
    });

    const joined = log.lines.join('\n');
    assert.ok(joined.includes('8.8.8'), 'should log the refreshed version');
    assert.ok(joined.includes(CACHE_PATH), 'should log the cache path');
    // The raw JSON payload (with its quoted keys) must not be echoed wholesale.
    assert.ok(
      !joined.includes('"latestVersion"'),
      'must not log raw file contents',
    );
  });
});
