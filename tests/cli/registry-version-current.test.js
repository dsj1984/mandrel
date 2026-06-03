// tests/cli/registry-version-current.test.js
/**
 * Unit tests for the `version-current` doctor check in lib/cli/registry.js.
 *
 * The check reads the daily freshness cache written by lib/cli/version-check.js
 * (Story #3500) and surfaces a NON-FATAL advisory when a newer version than the
 * installed one is already cached locally. It is cache-only — it calls
 * `readCache`, never `isStale`, so it issues NO network request. Every branch is
 * driven through injectable seams (`cachePath`, `installedVersion`, `fsImpl`) so
 * no real filesystem or network access occurs (testing-standards § Unit: all
 * filesystem and network I/O MUST be mocked).
 *
 * Coverage contract (per Story #3507 AC):
 *   1. The registry exposes a `version-current` check whose run() reads the
 *      freshness cache only (no network) and returns { ok, detail, remedy? }.
 *   2. When a newer version is cached, the check reports it as a non-fatal
 *      advisory: ok:true (so it never blocks CI / flips the doctor exit code),
 *      `detail` names the available version, and an actionable `remedy` points
 *      at `mandrel update`. The registry entry is flagged `advisory: true`.
 *   3. A current / missing / malformed cache returns ok:true with no remedy.
 *   4. `node --test tests/cli/registry-version-current.test.js` exits 0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registry } from '../../lib/cli/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CACHE_PATH = '/tmp/mandrel/version-check.json';

/** Locate the version-current check, failing fast if it is missing. */
function versionCurrentCheck() {
  const check = registry.find((c) => c.name === 'version-current');
  assert.ok(check, 'Expected a `version-current` check in the registry');
  return check;
}

/**
 * Assert the standard doctor result shape: `{ ok, detail, remedy? }`, with a
 * non-empty `remedy` whenever `ok` is false. Mirrors the helper in the sibling
 * registry test files.
 *
 * @param {{ ok: unknown, detail: unknown, remedy?: unknown }} result
 * @param {{ expectOk?: boolean }} [opts]
 */
function assertResultShape(result, { expectOk } = {}) {
  assert.equal(typeof result.ok, 'boolean', 'result.ok must be boolean');
  assert.equal(typeof result.detail, 'string', 'result.detail must be string');
  assert.ok(result.detail.length > 0, 'result.detail must be non-empty');
  if (!result.ok) {
    assert.equal(
      typeof result.remedy,
      'string',
      'result.remedy must be a string when ok is false',
    );
    assert.ok(
      result.remedy.length > 0,
      'result.remedy must be non-empty when ok is false',
    );
  }
  if (expectOk !== undefined) {
    assert.equal(result.ok, expectOk, `Expected result.ok to be ${expectOk}`);
  }
}

/**
 * Build a minimal in-memory fs seam exposing only `readFileSync`, seeded with a
 * `{ absolutePath: stringContents }` map. A `readCount` accumulator records
 * every read so a test can prove the check never reaches beyond the cache.
 *
 * @param {Record<string, string>} seed
 * @returns {{ readFileSync: (p: string) => string, reads: string[] }}
 */
function makeReadOnlyFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const reads = [];
  return {
    reads,
    readFileSync(p, _enc) {
      reads.push(p);
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files.get(p);
    },
  };
}

/** Serialize a freshness-cache record the way version-check.js#refreshCache does. */
function cacheJson(latestVersion, checkedAt = new Date().toISOString()) {
  return `${JSON.stringify({ latestVersion, checkedAt }, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('version-current registry entry', () => {
  it('is registered with a run function', () => {
    const check = versionCurrentCheck();
    assert.equal(typeof check.run, 'function');
  });

  it('is flagged advisory:true so downstream renderers treat it as non-fatal', () => {
    const check = versionCurrentCheck();
    assert.equal(check.advisory, true);
  });
});

// ---------------------------------------------------------------------------
// Newer version cached → non-fatal advisory
// ---------------------------------------------------------------------------

describe('version-current — a newer version is cached', () => {
  const fsImpl = makeReadOnlyFs({ [CACHE_PATH]: cacheJson('2.0.0') });

  it('reports an actionable remedy but stays ok:true (advisory, never blocks CI)', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl,
    });
    // Non-fatal: ok stays true so the doctor exit code / CI is never flipped.
    assert.equal(result.ok, true, 'a stale advisory must not fail the doctor');
    assert.equal(typeof result.remedy, 'string');
    assert.ok(
      result.remedy.length > 0,
      'advisory must carry an actionable remedy',
    );
    assert.match(result.remedy, /mandrel update/);
  });

  it('names both the installed and the available version in the detail', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl: makeReadOnlyFs({ [CACHE_PATH]: cacheJson('2.0.0') }),
    });
    assert.match(result.detail, /1\.43\.0/);
    assert.match(result.detail, /2\.0\.0/);
    assert.match(result.detail, /advisory/i);
  });

  it('reads only the cache file — never issues a network call', () => {
    const probe = makeReadOnlyFs({ [CACHE_PATH]: cacheJson('1.99.0') });
    const check = versionCurrentCheck();
    check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl: probe,
    });
    // The only filesystem read is the cache itself; no manifest read (the
    // installedVersion seam short-circuits it) and certainly no network.
    assert.deepEqual(probe.reads, [CACHE_PATH]);
  });
});

// ---------------------------------------------------------------------------
// Up to date / minor-or-equal cache → ok, no remedy
// ---------------------------------------------------------------------------

describe('version-current — installed version is current', () => {
  it('returns ok:true with no remedy when the cached version equals the installed one', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl: makeReadOnlyFs({ [CACHE_PATH]: cacheJson('1.43.0') }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.remedy, undefined);
    assert.match(result.detail, /up to date/);
  });

  it('returns ok:true with no remedy when the installed version is ahead of the cache', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '2.0.0',
      fsImpl: makeReadOnlyFs({ [CACHE_PATH]: cacheJson('1.43.0') }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.remedy, undefined);
  });
});

// ---------------------------------------------------------------------------
// Missing / malformed cache → non-fatal, no remedy
// ---------------------------------------------------------------------------

describe('version-current — no usable cache', () => {
  it('returns ok:true with no remedy when the cache file is absent', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl: makeReadOnlyFs({}), // nothing seeded → readCache returns null
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.remedy, undefined);
    assert.match(result.detail, /1\.43\.0/);
  });

  it('returns ok:true with no remedy when the cache JSON is malformed', () => {
    const check = versionCurrentCheck();
    const result = check.run({
      cachePath: CACHE_PATH,
      installedVersion: '1.43.0',
      fsImpl: makeReadOnlyFs({ [CACHE_PATH]: '{ not json' }),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.remedy, undefined);
  });
});

// ---------------------------------------------------------------------------
// Installed version unknown → non-fatal skip
// ---------------------------------------------------------------------------

describe('version-current — installed version cannot be resolved', () => {
  it('returns ok:true and skips when the package manifest is unreadable', () => {
    const check = versionCurrentCheck();
    // No installedVersion seam and an fs whose every read throws → the manifest
    // read inside defaultInstalledVersion fails and the check skips non-fatally.
    const result = check.run({
      cachePath: CACHE_PATH,
      fsImpl: makeReadOnlyFs({}),
    });
    assertResultShape(result, { expectOk: true });
    assert.equal(result.remedy, undefined);
    assert.match(result.detail, /unknown/);
  });
});
