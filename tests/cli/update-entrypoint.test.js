// tests/cli/update-entrypoint.test.js
/**
 * Contract-tier test for the REAL `mandrel update` entrypoint — the default
 * export `run(argv)` consumed by `bin/mandrel.js` (Story #3503, Epic #3437 —
 * Auto-Update & Version Lifecycle).
 *
 * The sibling unit tests (`lib/cli/__tests__/update*.test.js`) drive the
 * `runUpdate` engine through hand-built seams; the golden-path test
 * (`update-golden-path.test.js`) drives the ordered cycle against a stateful
 * fixture. NONE of them exercise the production wiring inside the default
 * export — which is exactly where the Phase 5 blocker lived: `run(argv)` used
 * to call `runUpdate({ argv })` WITHOUT the required `resolveTargetVersion` /
 * `npmUpdate` seams, so a real `mandrel update` threw "seam is required" and
 * the headline feature was dead in production.
 *
 * This file proves the boundary contract between the entrypoint and the
 * process/filesystem seams its production defaults shell across:
 *   (a) `run(argv)` does NOT throw "seam is required" — the production
 *       defaults satisfy every required `runUpdate` seam.
 *   (b) the ordered cycle (npm-install → sync → migrations → doctor →
 *       changelog) runs.
 *   (c) `--dry-run` writes NOTHING to disk and runs no effectful seam.
 *   (d) the freshness-cache write path is exercised — resolving the target
 *       version through `version-check.js#isStale` populates
 *       `temp/version-check.json`, fixing the second blocker (the
 *       `version-current` doctor advisory was always empty because nothing
 *       wrote that cache).
 *
 * Tier: contract (testing-standards § Contract). The boundary under test is
 * the entrypoint's contract with its npm/network/filesystem seams. The npm
 * boundary (`npm view`, `npm install`) is stubbed via injected runners and the
 * filesystem is an in-memory fake, so NO real network call, npm process, or
 * disk write occurs. The injected `deps` mirror the production boundaries
 * exactly — `bin/mandrel.js` calls `run(argv)` with no `deps` and gets the
 * real `spawnSync`-backed wiring.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): the fixtures
 * carry only version strings and paths; no tokens, credentials, or env values
 * are constructed or logged.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import run from '../../lib/cli/update.js';

const CURRENT_VERSION = '1.43.0';
const TARGET_VERSION = '1.44.0';
const CACHE_PATH = '/virtual/temp/version-check.json';
const CHANGELOG_PATH = '/virtual/docs/CHANGELOG.md';

const CHANGELOG_CONTENT = `# Changelog

## [1.44.0](https://example.test/compare/v1.43.0...v1.44.0) (2026-06-03)

### Added

* the headline auto-update feature

## [1.43.0](https://example.test/compare/v1.42.0...v1.43.0) (2026-06-02)

### Fixed

* an older fix
`;

/**
 * Minimal in-memory `node:fs` fake exposing exactly the surface the production
 * defaults reach: `readFileSync`, `writeFileSync`, `mkdirSync`. Records every
 * write so a test can prove the cache write path fired (or, under --dry-run,
 * never did).
 *
 * @param {Record<string,string>} seed
 */
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const writes = [];
  const mkdirs = [];
  return {
    files,
    writes,
    mkdirs,
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return files.get(p);
    },
    writeFileSync(p, content, _enc) {
      files.set(p, content);
      writes.push({ path: p, content });
    },
    mkdirSync(p, _opts) {
      mkdirs.push(p);
    },
    existsSync(p) {
      return files.has(p);
    },
  };
}

/** Capture stdout/stderr writes and the exit code. */
function makeCapture() {
  const out = [];
  const err = [];
  let exitCode = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: (code) => {
      exitCode = code;
    },
  };
}

/**
 * Build the stubbed process/filesystem boundary `deps` for `run`. `npm view`
 * and `npm install` are fakes that record their invocation; the freshness
 * cache and changelog live in the in-memory fs. A fixed `currentVersion` keeps
 * the entrypoint off this repo's real manifest.
 */
function makeDeps(fsFake, cap, { onNpmView, onNpmInstall } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      currentVersion: CURRENT_VERSION,
      cachePath: CACHE_PATH,
      changelogPath: CHANGELOG_PATH,
      fs: fsFake,
      now: new Date('2026-06-03T00:00:00.000Z'),
      versionRunner: () => {
        calls.push('npm-view');
        if (onNpmView) onNpmView();
        return TARGET_VERSION;
      },
      runInstall: (installCmd, cwd) => {
        calls.push(installCmd);
        if (onNpmInstall) onNpmInstall(installCmd, cwd);
        return { status: 0, stderr: '' };
      },
      // Downstream materialize/migrate/verify seams are stubbed: the boundary
      // under test is the entrypoint ↔ npm/network/fs wiring, not sync.js's
      // real @mandrelai/agents resolution (absent in this dev repo).
      runSync: () => {
        calls.push('runSync');
        return { copied: 0, planned: 0, dryRun: false };
      },
      runMigrations: ({ fromVersion, toVersion }) => {
        calls.push(`runMigrations:${fromVersion}->${toVersion}`);
        return { applied: [], skipped: [] };
      },
      runDoctor: async () => {
        calls.push('runDoctor');
        return { ok: true, results: [{ name: 'node-version', ok: true }] };
      },
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    },
  };
}

// ---------------------------------------------------------------------------
// (a) + (b) — real run(argv) does not throw "seam is required"; cycle runs
// ---------------------------------------------------------------------------

describe('mandrel update entrypoint — production wiring', () => {
  it('does not throw "seam is required" when driven through the real default export', async () => {
    const fsFake = makeFs({ [CHANGELOG_PATH]: CHANGELOG_CONTENT });
    const cap = makeCapture();
    const { deps } = makeDeps(fsFake, cap);

    // The Phase 5 blocker: run(argv) used to throw here. It must not.
    await assert.doesNotReject(() => run([], deps));
  });

  it('runs the ordered cycle: npm view → npm install → changelog, and reports success', async () => {
    const fsFake = makeFs({ [CHANGELOG_PATH]: CHANGELOG_CONTENT });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);

    await run([], deps);

    // The newest version was probed, then the full ordered cycle ran:
    // install → sync → migrate → doctor (changelog is surfaced via the fs).
    assert.deepEqual(calls, [
      'npm-view',
      `npm install @mandrelai/agents@${TARGET_VERSION}`,
      'runSync',
      `runMigrations:${CURRENT_VERSION}->${TARGET_VERSION}`,
      'runDoctor',
    ]);
    // Success surface + staged-lockfile messaging from runUpdate.
    const joined = cap.out.join('');
    assert.match(joined, /Updated to v1\.44\.0/);
    assert.match(joined, /staged for review/);
    // The changelog section for the applied version was surfaced.
    assert.match(joined, /Changelog for v1\.44\.0/);
    assert.match(joined, /headline auto-update feature/);
    // …and only the in-range section — not the older 1.43.0 entry.
    assert.doesNotMatch(joined, /an older fix/);
    assert.equal(cap.exitCode, null);
  });
});

// ---------------------------------------------------------------------------
// (d) — the freshness-cache write path is exercised (fixes empty advisory)
// ---------------------------------------------------------------------------

describe('mandrel update entrypoint — freshness-cache population', () => {
  it('writes temp/version-check.json when resolving the target through a stale/absent cache', async () => {
    // No cache seeded → isStale treats it as absent → one network probe +
    // refreshCache write. This is exactly what keeps the version-current
    // doctor advisory non-empty.
    const fsFake = makeFs({ [CHANGELOG_PATH]: CHANGELOG_CONTENT });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);

    await run([], deps);

    // The probe ran exactly once and the cache was written to the temp path.
    assert.ok(calls.includes('npm-view'), 'expected one npm view probe');
    const cacheWrite = fsFake.writes.find((w) => w.path === CACHE_PATH);
    assert.ok(cacheWrite, 'expected the freshness cache to be written');
    const record = JSON.parse(cacheWrite.content);
    assert.equal(record.latestVersion, TARGET_VERSION);
    assert.equal(typeof record.checkedAt, 'string');
  });

  it('honours a fresh cache: resolves the target with no network probe', async () => {
    const freshCache = `${JSON.stringify(
      { latestVersion: TARGET_VERSION, checkedAt: '2026-06-02T23:30:00.000Z' },
      null,
      2,
    )}\n`;
    const fsFake = makeFs({
      [CACHE_PATH]: freshCache,
      [CHANGELOG_PATH]: CHANGELOG_CONTENT,
    });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);

    await run([], deps);

    // Fresh cache (< 24h old relative to the injected `now`) → no npm view.
    assert.ok(!calls.includes('npm-view'), 'fresh cache must skip the probe');
    // The install still ran at the cached target.
    assert.ok(
      calls.includes(`npm install @mandrelai/agents@${TARGET_VERSION}`),
      'expected install at the cached target',
    );
  });
});

// ---------------------------------------------------------------------------
// (c) — --dry-run writes nothing and runs no effectful seam
// ---------------------------------------------------------------------------

describe('mandrel update entrypoint — --dry-run', () => {
  it('writes nothing to disk and never installs', async () => {
    // Fresh cache so resolving the target needs no probe either; the dry-run
    // must touch neither the npm install boundary nor the filesystem.
    const freshCache = `${JSON.stringify(
      { latestVersion: TARGET_VERSION, checkedAt: '2026-06-02T23:30:00.000Z' },
      null,
      2,
    )}\n`;
    const fsFake = makeFs({
      [CACHE_PATH]: freshCache,
      [CHANGELOG_PATH]: CHANGELOG_CONTENT,
    });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);

    await run(['--dry-run'], deps);

    // No install, no changelog surface — runUpdate short-circuits the dry run
    // before any effectful seam.
    assert.ok(
      !calls.some((c) => c.startsWith('npm install')),
      'dry-run must not install',
    );
    // No filesystem writes occurred (the fresh cache was only read).
    assert.deepEqual(fsFake.writes, [], 'dry-run must write nothing to disk');
    // The plan was printed.
    const joined = cap.out.join('');
    assert.match(joined, /planned upgrade v1\.43\.0 → v1\.44\.0/);
    assert.match(joined, /Dry run: no files written/);
    assert.equal(cap.exitCode, null);
  });
});
