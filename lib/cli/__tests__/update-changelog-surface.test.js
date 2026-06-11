// lib/cli/__tests__/update-changelog-surface.test.js
/**
 * Unit tests for the `defaultSurfaceChangelog` fallback chain and
 * `fetchChangelogFromGitHub` introduced by Story #4035 — mandrel update
 * changelog surface (ship or fetch).
 *
 * The three paths under test (via the `run` entrypoint):
 *   1. Packaged file present → reads and prints the matching section(s).
 *   2. Packaged file absent, GitHub fetch succeeds → prints the section(s)
 *      from the fetched content.
 *   3. Both sources unavailable → emits an actionable warning with a link
 *      to the GitHub Releases page; never throws.
 *
 * Plus unit coverage for `fetchChangelogFromGitHub` itself:
 *   - Resolves the content from the first tag that returns 2xx.
 *   - Tries the namespaced tag (`mandrel-v<ver>`) first, then bare (`v<ver>`).
 *   - Throws when both tag forms return non-2xx.
 *   - Throws when the HTTP request errors out.
 *
 * `defaultSurfaceChangelog` is exercised through the `run` default export
 * so the full wiring from `deps` through to output is verified. The
 * `fetchChangelog` seam (and `https` in `fetchChangelogFromGitHub`) are
 * injected so no real HTTP call occurs (testing-standards § Unit: mock all I/O).
 *
 * Tier: unit (testing-standards § Unit). All I/O — filesystem and network
 * — is mocked via injectable seams.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): fixtures carry
 * only version strings and file paths; no tokens or credentials are used.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import run, { fetchChangelogFromGitHub } from '../update.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CURRENT_VERSION = '1.58.0';
const TARGET_VERSION = '1.59.0';
const CACHE_PATH = '/virtual/temp/version-check.json';
const CHANGELOG_PATH = '/virtual/docs/CHANGELOG.md';

const CHANGELOG_CONTENT = `# Changelog

## [1.59.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.58.0...mandrel-v1.59.0) (2026-06-11)

### Added

* **cli:** add mandrel init one-command cold start

## [1.58.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.57.0...mandrel-v1.58.0) (2026-05-30)

### Fixed

* an older fix from 1.58
`;

/**
 * Minimal in-memory fs fake. When `changelogContent` is provided, the
 * changelog path resolves; otherwise it throws ENOENT (simulating the
 * absent-from-tarball scenario pre-Story #4035).
 *
 * @param {{ changelogContent?: string }} [opts]
 */
function makeFs({ changelogContent } = {}) {
  const files = new Map([
    [
      CACHE_PATH,
      JSON.stringify({
        latestVersion: TARGET_VERSION,
        checkedAt: '2026-06-11T00:00:00.000Z',
      }),
    ],
    ...(changelogContent ? [[CHANGELOG_PATH, changelogContent]] : []),
  ]);
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files.get(p);
    },
    writeFileSync() {},
    mkdirSync() {},
    existsSync(p) {
      return files.has(p);
    },
  };
}

/** Capture stdout/stderr writes. */
function makeCapture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: () => {},
  };
}

/**
 * Build the stubbed `deps` for `run`. Downstream seams (sync, migrate,
 * doctor) are no-ops — the boundary under test is the changelog surface.
 *
 * @param {{
 *   fs: ReturnType<typeof makeFs>,
 *   cap: ReturnType<typeof makeCapture>,
 *   fetchChangelog?: (v: string) => Promise<string>,
 * }} opts
 */
function makeDeps(fs, cap, fetchChangelog) {
  return {
    currentVersion: CURRENT_VERSION,
    cachePath: CACHE_PATH,
    changelogPath: CHANGELOG_PATH,
    fs,
    now: new Date('2026-06-11T00:30:00.000Z'),
    versionRunner: () => TARGET_VERSION,
    runInstall: () => ({ status: 0, stderr: '' }),
    runSync: () => ({ copied: 0, planned: 0, dryRun: false }),
    runMigrations: () => ({ applied: [], skipped: [] }),
    runDoctor: async () => ({ ok: true, results: [] }),
    write: cap.write,
    writeErr: cap.writeErr,
    exit: cap.exit,
    ...(fetchChangelog !== undefined ? { fetchChangelog } : {}),
  };
}

// ---------------------------------------------------------------------------
// Path 1 — packaged file present
// ---------------------------------------------------------------------------

describe('defaultSurfaceChangelog — packaged file present (Story #4035)', () => {
  it('prints the matching in-range section from the packaged changelog', async () => {
    const fs = makeFs({ changelogContent: CHANGELOG_CONTENT });
    const cap = makeCapture();

    await run([], makeDeps(fs, cap));

    const joined = cap.out.join('');
    // In-range (1.59.0) section surfaced.
    assert.match(joined, /Changelog for v1\.59\.0/);
    assert.match(joined, /mandrel init one-command cold start/);
    // Out-of-range section (1.58.0) must NOT appear.
    assert.doesNotMatch(joined, /an older fix from 1\.58/);
  });

  it('does not invoke the GitHub fetch seam when the packaged file is readable', async () => {
    const fs = makeFs({ changelogContent: CHANGELOG_CONTENT });
    const cap = makeCapture();
    let fetchCalled = false;
    const fetchChangelog = async () => {
      fetchCalled = true;
      return CHANGELOG_CONTENT;
    };

    await run([], makeDeps(fs, cap, fetchChangelog));

    assert.equal(
      fetchCalled,
      false,
      'GitHub fetch must not run when packaged file is present',
    );
  });
});

// ---------------------------------------------------------------------------
// Path 2 — packaged file absent, GitHub fetch succeeds
// ---------------------------------------------------------------------------

describe('defaultSurfaceChangelog — GitHub fetch fallback (Story #4035)', () => {
  it('fetches from GitHub and prints the matching section when the packaged file is absent', async () => {
    const fs = makeFs(); // no changelog seeded → ENOENT
    const cap = makeCapture();
    const fetchChangelog = async (_version) => CHANGELOG_CONTENT;

    await run([], makeDeps(fs, cap, fetchChangelog));

    const joined = cap.out.join('');
    assert.match(joined, /Changelog for v1\.59\.0/);
    assert.match(joined, /mandrel init one-command cold start/);
    assert.doesNotMatch(joined, /an older fix from 1\.58/);
    // No error written — successful fallback.
    assert.deepEqual(cap.err, []);
  });

  it('passes the target version to the fetchChangelog seam', async () => {
    const fs = makeFs();
    const cap = makeCapture();
    const fetched = [];
    const fetchChangelog = async (version) => {
      fetched.push(version);
      return CHANGELOG_CONTENT;
    };

    await run([], makeDeps(fs, cap, fetchChangelog));

    assert.deepEqual(fetched, [TARGET_VERSION]);
  });
});

// ---------------------------------------------------------------------------
// Path 3 — both sources unavailable → actionable degradation message
// ---------------------------------------------------------------------------

describe('defaultSurfaceChangelog — actionable degradation (Story #4035)', () => {
  it('emits a message with the GitHub Releases URL when both sources fail', async () => {
    const fs = makeFs(); // no changelog → ENOENT
    const cap = makeCapture();
    const fetchChangelog = async () => {
      throw new Error('HTTP 404');
    };

    await run([], makeDeps(fs, cap, fetchChangelog));

    const errJoined = cap.err.join('');
    // Must mention v1.59.0 and include the releases link.
    assert.match(errJoined, /v1\.59\.0/);
    assert.match(errJoined, /github\.com\/dsj1984\/mandrel\/releases/);
    // Must NOT be the old bare "not found … skipping" message.
    assert.doesNotMatch(errJoined, /skipping changelog surface/);
  });

  it('never throws even when both the packaged file and GitHub fetch fail', async () => {
    const fs = makeFs();
    const cap = makeCapture();
    const fetchChangelog = async () => {
      throw new Error('network error');
    };

    // Must not reject.
    await assert.doesNotReject(() =>
      run([], makeDeps(fs, cap, fetchChangelog)),
    );
  });

  it('emits an actionable message when the changelog has no matching section', async () => {
    // Changelog only has a 1.57.0 entry — no 1.59.0 section.
    const sparseChangelog = `# Changelog\n\n## [1.57.0](https://example.test) (2026-04-01)\n\n### Fixed\n\n* old fix\n`;
    const fs = makeFs({ changelogContent: sparseChangelog });
    const cap = makeCapture();

    await run([], makeDeps(fs, cap));

    const errJoined = cap.err.join('');
    assert.match(errJoined, /v1\.59\.0/);
    assert.match(errJoined, /github\.com\/dsj1984\/mandrel\/releases/);
    assert.doesNotMatch(errJoined, /skipping changelog surface/);
  });
});

// ---------------------------------------------------------------------------
// fetchChangelogFromGitHub unit tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake `node:https` module. Each `response` entry defines
 * `{ status, body }` for successive calls to `https.get`. When an entry has
 * `error: true` the fake emits an 'error' event on the request object instead
 * of responding.
 *
 * @param {Array<{ status?: number, body?: string, error?: boolean }>} responses
 */
function makeHttpsFake(responses) {
  let callIdx = 0;
  const capturedUrls = [];
  return {
    capturedUrls,
    https: {
      get(url, callback) {
        capturedUrls.push(url);
        const entry = responses[callIdx] ?? { status: 404, body: '' };
        callIdx += 1;

        const req = new EventEmitter();

        if (entry.error) {
          // Emit 'error' asynchronously so the Promise constructor has time to
          // attach the `.on('error')` listener.
          setImmediate(() =>
            req.emit('error', new Error('connection refused')),
          );
        } else {
          const res = new EventEmitter();
          res.statusCode = entry.status ?? 200;
          setImmediate(() => {
            callback(res);
            res.emit('data', Buffer.from(entry.body ?? ''));
            res.emit('end');
          });
        }

        return req;
      },
    },
  };
}

describe('fetchChangelogFromGitHub — HTTP seam (Story #4035)', () => {
  it('returns the body from a 200 response on the namespaced tag', async () => {
    const { https, capturedUrls } = makeHttpsFake([
      { status: 200, body: '# Changelog\n\n## [1.59.0] content' },
    ]);

    const result = await fetchChangelogFromGitHub('1.59.0', { https });

    assert.match(result, /\[1\.59\.0\] content/);
    // Must have tried the namespaced tag first.
    assert.ok(
      capturedUrls[0].includes('mandrel-v1.59.0'),
      'namespaced tag tried first',
    );
  });

  it('falls back to bare vX.Y.Z tag when the namespaced tag returns 404', async () => {
    const { https, capturedUrls } = makeHttpsFake([
      { status: 404, body: 'Not Found' }, // mandrel-v1.59.0 → 404
      { status: 200, body: '# Changelog\n## [1.59.0] bare' }, // v1.59.0 → 200
    ]);

    const result = await fetchChangelogFromGitHub('1.59.0', { https });

    assert.match(result, /\[1\.59\.0\] bare/);
    assert.equal(capturedUrls.length, 2);
    assert.ok(capturedUrls[0].includes('mandrel-v1.59.0'));
    assert.ok(capturedUrls[1].includes('/v1.59.0/'));
  });

  it('throws when both tag forms return non-2xx', async () => {
    const { https } = makeHttpsFake([
      { status: 404, body: 'Not Found' },
      { status: 404, body: 'Not Found' },
    ]);

    await assert.rejects(
      () => fetchChangelogFromGitHub('1.59.0', { https }),
      /non-2xx for all tag forms/,
    );
  });

  it('throws when the HTTP request emits an error', async () => {
    const { https } = makeHttpsFake([{ error: true }]);

    await assert.rejects(
      () => fetchChangelogFromGitHub('1.59.0', { https }),
      /connection refused/,
    );
  });
});
