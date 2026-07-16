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
 *   (b) the ordered cycle (npm-install → sync → sync-commands → migrate →
 *       doctor → changelog) runs through the spawn boundary.
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
      // Downstream materialize/migrate/verify phases run through the spawn
      // boundary (the sole post-install path since Story #4182 retired the
      // in-process runSync/runMigrations/runDoctor seam set). The boundary under
      // test is the entrypoint ↔ npm/network/fs wiring, not sync.js's real
      // mandrel resolution (absent in this dev repo), so spawnFn is stubbed:
      // each phase records its name and exits 0 (doctor passes). The stub keys
      // off argv[0] = the mandrel sub-command (sync / sync-commands / migrate /
      // doctor).
      spawnFn: (_binPath, argv) => {
        const phase = argv[0];
        if (phase === 'migrate') {
          const from = argv[argv.indexOf('--from') + 1];
          const to = argv[argv.indexOf('--to') + 1];
          calls.push(`migrate:${from}->${to}`);
        } else {
          calls.push(`spawn:${phase}`);
        }
        return { status: 0, stdout: '', stderr: '' };
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
    // install → sync → sync-commands → migrate → doctor (changelog is surfaced
    // via the fs; sync-commands sits between sync and migrate — Story #4046 A1c).
    assert.deepEqual(calls, [
      'npm-view',
      `npm install mandrel@${TARGET_VERSION}`,
      'spawn:sync',
      'spawn:sync-commands',
      `migrate:${CURRENT_VERSION}->${TARGET_VERSION}`,
      'spawn:doctor',
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

  it('always probes the registry on explicit update even when cache is fresh (A1b)', async () => {
    // Story #4046 A1b: an explicit `mandrel update` bypasses the 24h cache so
    // the resolved target is always fresh from the registry. A fresh cache must
    // NOT suppress the probe on an explicit update call.
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

    // Fresh cache present, but the bypass must still issue one registry probe.
    assert.ok(
      calls.includes('npm-view'),
      'explicit update must probe registry even with a fresh cache (A1b)',
    );
    // The install still ran at the probed target.
    assert.ok(
      calls.includes(`npm install mandrel@${TARGET_VERSION}`),
      'expected install at the probed target',
    );
  });
});

// ---------------------------------------------------------------------------
// (c) — --dry-run does not install or run effectful phases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Story #4525/#4530 — production `current` resolution reads the consumer pin
// ---------------------------------------------------------------------------

describe('mandrel update entrypoint — resolves current from the consumer pin', () => {
  it('resolves an updated action from a lagging package.json pin, with no currentVersion override (the #4525 repro)', async () => {
    // No `deps.currentVersion` — this is the production default-resolution
    // path. package.json pins ^1.87.0 (analogous to the reported skew); the
    // registry probe resolves the newer TARGET_VERSION. The pin, not any
    // node_modules resolution, must drive `current`.
    const consumerRoot = '/virtual/consumer';
    const fsFake = makeFs({
      [CHANGELOG_PATH]: CHANGELOG_CONTENT,
      [`${consumerRoot}/package.json`]: JSON.stringify({
        dependencies: { mandrel: '^1.43.0' },
      }),
    });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);
    delete deps.currentVersion;
    deps.cwd = () => consumerRoot;

    await run([], deps);

    // The full 'updated' cycle ran — proving planUpdate saw `updated`, not
    // `resynced` — which is only possible if current (1.43.0, from the pin)
    // compared as behind target (1.44.0).
    assert.deepEqual(calls, [
      'npm-view',
      `npm install mandrel@${TARGET_VERSION}`,
      'spawn:sync',
      'spawn:sync-commands',
      'migrate:1.43.0->1.44.0',
      'spawn:doctor',
    ]);
    const joined = cap.out.join('');
    assert.match(joined, /Updated to v1\.44\.0/);
    assert.equal(cap.exitCode, null);
  });

  it('resolves up-to-date (no npm-update) when the pin already matches the target', async () => {
    const consumerRoot = '/virtual/consumer2';
    const fsFake = makeFs({
      [CHANGELOG_PATH]: CHANGELOG_CONTENT,
      [`${consumerRoot}/package.json`]: JSON.stringify({
        dependencies: { mandrel: `^${TARGET_VERSION}` },
      }),
    });
    const cap = makeCapture();
    const { calls, deps } = makeDeps(fsFake, cap);
    delete deps.currentVersion;
    deps.cwd = () => consumerRoot;
    // Pin resolves current===target, so runUpdate probes drift. Stub it false
    // so this test stays hermetic — without this it falls through to the
    // real runAgentsDrift() against process.cwd()'s actual .agents/ state.
    deps.checkDrift = () => false;

    await run([], deps);

    assert.ok(
      !calls.some((c) => c.startsWith('npm install')),
      'pin already matches target — no install should run',
    );
    assert.match(cap.out.join(''), /Already up to date/);
  });
});

describe('mandrel update entrypoint — --dry-run', () => {
  it('never installs and prints the step plan (A1b, A1c)', async () => {
    // Story #4046 A1b: the cache is bypassed even on dry-run — the version is
    // resolved fresh from the registry to show the real available version in
    // the plan. However, no npm install, no sync, no migrate, and no doctor
    // run — those effectful seams never fire.
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

    // No install — the dry-run never bumps the dependency.
    assert.ok(
      !calls.some((c) => c.startsWith('npm install')),
      'dry-run must not install',
    );
    // No post-install phase is spawned (no sync / sync-commands / migrate /
    // doctor).
    assert.ok(
      !calls.some((c) => c.startsWith('spawn:')),
      'dry-run must not spawn any post-install phase',
    );
    assert.ok(
      !calls.some((c) => c.startsWith('migrate:')),
      'dry-run must not run migrations',
    );

    // The plan was printed with the A1c step list.
    const joined = cap.out.join('');
    assert.match(joined, /planned upgrade v1\.43\.0 → v1\.44\.0/);
    assert.match(joined, /Dry run: no files written/);
    // sync-commands appears in the plan (A1c).
    assert.match(joined, /sync-commands/);
    assert.equal(cap.exitCode, null);
  });
});
