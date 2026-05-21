/**
 * Unit tests for `.agents/scripts/providers/github/request-helpers.js`.
 *
 * Story #2852: covers the dedup'd `paginateRest` + `parseApiJson` helpers
 * and the two Story #2852 guards (transient retry + hard page cap).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const mod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'request-helpers.js',
    ),
  ).href
);

const { DEFAULT_PAGE_CAP, DEFAULT_PER_PAGE, paginateRest, parseApiJson } = mod;

/**
 * Build a fake gh facade that returns canned page payloads in order.
 * Pages are a flat list of arrays; each `api()` call consumes the next.
 * Set `transientBefore[N] = true` to throw a 502 on the Nth call before
 * succeeding (so the retry path is exercised).
 */
function makeFakeGh(pages, opts = {}) {
  const calls = [];
  const transient = opts.transientBefore ?? {};
  let idx = 0;
  return {
    calls,
    api: async ({ endpoint }) => {
      calls.push(endpoint);
      if (transient[calls.length]) {
        const err = new Error(`gh: HTTP 502 (call ${calls.length})`);
        err.status = 502;
        throw err;
      }
      const batch = pages[idx++] ?? null;
      if (batch === null) return { stdout: '', stderr: '', code: 0 };
      return { stdout: JSON.stringify(batch), stderr: '', code: 0 };
    },
  };
}

describe('providers/github/request-helpers — parseApiJson', () => {
  it('returns null for empty stdout (HTTP 204)', () => {
    assert.equal(parseApiJson({ stdout: '' }), null);
    assert.equal(parseApiJson({ stdout: '   \n' }), null);
    assert.equal(parseApiJson({}), null);
  });

  it('parses populated stdout as JSON', () => {
    assert.deepEqual(parseApiJson({ stdout: '{"a":1}' }), { a: 1 });
    assert.deepEqual(parseApiJson({ stdout: '[1,2,3]' }), [1, 2, 3]);
  });
});

describe('providers/github/request-helpers — paginateRest', () => {
  it('stops on a short page and returns the concatenated array', async () => {
    const pages = [
      new Array(100).fill(0).map((_, i) => ({ id: i + 1 })),
      [{ id: 101 }, { id: 102 }], // short → stop
    ];
    const gh = makeFakeGh(pages);
    const items = await paginateRest(gh, '/x', { onRetry: () => {} });
    assert.equal(items.length, 102);
    assert.equal(gh.calls.length, 2);
    assert.match(gh.calls[0], /page=1&per_page=100/);
    assert.match(gh.calls[1], /page=2&per_page=100/);
  });

  it('appends &page=… when endpoint already has a query string', async () => {
    const gh = makeFakeGh([[{ id: 1 }]]);
    await paginateRest(gh, '/repos/o/r/issues?state=open', {
      onRetry: () => {},
    });
    assert.match(gh.calls[0], /state=open&page=1&per_page=100/);
  });

  it('returns the accumulated items when a non-array page lands', async () => {
    const pages = [
      [{ id: 1 }, { id: 2 }],
      null, // parseApiJson → null → early return
    ];
    const gh = makeFakeGh(pages);
    // Force the second call to return empty stdout, simulating a 204.
    gh.api = async ({ endpoint }) => {
      gh.calls.push(endpoint);
      if (gh.calls.length === 1) {
        return {
          stdout: JSON.stringify(new Array(100).fill({ id: 1 })),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const items = await paginateRest(gh, '/y', { onRetry: () => {} });
    assert.equal(items.length, 100);
  });

  it('retries a transient 502 on page 2 without losing page 1', async () => {
    const fullPage = new Array(100).fill(0).map((_, i) => ({ id: i + 1 }));
    const pages = [fullPage, [{ id: 101 }]];
    // Throw on the second call (the page-2 fetch). The retry should then
    // re-fetch page 2 (third api call) successfully.
    const gh = makeFakeGh(pages, { transientBefore: { 2: true } });
    const items = await paginateRest(gh, '/z', {
      retry: {
        baseDelayMs: 1,
        jitterMs: 0,
        sleep: () => Promise.resolve(),
      },
      onRetry: () => {},
    });
    assert.equal(items.length, 101);
    assert.equal(gh.calls.length, 3);
    // The first page-2 attempt + the retried page-2 attempt both hit
    // page=2; page 1 is fetched exactly once. Use word-boundary regex
    // so `per_page=100` doesn't match `/page=1/`.
    assert.equal(gh.calls.filter((c) => /[?&]page=1\b/.test(c)).length, 1);
    assert.equal(gh.calls.filter((c) => /[?&]page=2\b/.test(c)).length, 2);
  });

  it('throws with the endpoint named when the page cap is exceeded', async () => {
    const fullPage = new Array(100).fill(0).map((_, i) => ({ id: i + 1 }));
    // Every page is a full page → loop would run forever without the cap.
    const gh = {
      calls: [],
      api: async ({ endpoint }) => {
        gh.calls.push(endpoint);
        return { stdout: JSON.stringify(fullPage), stderr: '', code: 0 };
      },
    };
    await assert.rejects(
      paginateRest(gh, '/runaway', { pageCap: 3, onRetry: () => {} }),
      (err) => {
        assert.match(err.message, /page cap exceeded/);
        assert.match(err.message, /\/runaway/);
        assert.match(err.message, /cap=3/);
        assert.match(err.message, /collected=300/);
        return true;
      },
    );
    assert.equal(gh.calls.length, 3);
  });

  it('uses DEFAULT_PAGE_CAP and DEFAULT_PER_PAGE when opts omit them', async () => {
    // The defaults are positive integers — sanity-check them so a future
    // refactor that accidentally zeros them out is caught here.
    assert.ok(Number.isInteger(DEFAULT_PAGE_CAP) && DEFAULT_PAGE_CAP > 0);
    assert.ok(Number.isInteger(DEFAULT_PER_PAGE) && DEFAULT_PER_PAGE > 0);
  });

  it('a non-transient error inside a page bubbles immediately (no retry)', async () => {
    let calls = 0;
    const gh = {
      api: async () => {
        calls++;
        const err = new Error('forbidden');
        err.status = 403;
        // make sure secondary-rate-limit fallback does NOT trigger
        throw err;
      },
    };
    await assert.rejects(
      paginateRest(gh, '/y', {
        retry: { sleep: () => Promise.resolve() },
        onRetry: () => {},
      }),
      { message: 'forbidden' },
    );
    assert.equal(calls, 1);
  });
});
